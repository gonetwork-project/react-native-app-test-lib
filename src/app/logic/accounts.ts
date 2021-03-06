import { Observable, BehaviorSubject } from 'rxjs'
import {
  Engine, serviceCreate, setWaitForDefault, P2P, message, as, DateMs, fakeStorage, CHAIN_ID, BN, util
} from 'go-network-framework'

import { UserSession } from '../../protocol'

import { session, timeouts } from './setup'

import { Wei, BlockNumber, Address, PrivateKey } from 'eth-types'
import { openChannelAndDeposit } from './onchain-actions'

export interface Contracts {
  manager: Address
  gotToken: Address
  testToken: Address
}

export interface AccountBase {
  privateKey: PrivateKey
  privateKeyStr: string
  address: Address
  addressStr: string
  addressShort: string
}

export type Account = ReturnType<ReturnType<typeof initAccount>> extends Observable<infer U> ? U : never
export interface AccountBalance {
  blockNumber: BlockNumber
  wei: Wei
  gotToken: Wei
  hsToken: Wei
}

export interface AccountBalanceFormatted extends AccountBalance {
  eth: string
  got: string
  hs: string
  delta: { // since last block
    eth?: string
    got?: string
    hs?: string
  }
}

export interface OtherAccount {
  addressStr: string
  address: Address
  addressShort: string
  local?: Account
}

export enum EventSource {
  Blockchain = 'B',
  P2P = 'P',
  BlockNumber = 'N'
}

export interface Event {
  at: DateMs,
  block: number, // BN not need for forseeable future
  source: EventSource,
  event: any,
  account?: string
  header: string,
  payload: string,
  short: string
}

export type P2PMode = 'normal' | 'manual'

export type P2PProxy = ReturnType<typeof createP2PProxy>

export const toContracts = (contractsRaw: any) =>
  Object.keys(contractsRaw)
    .reduce((acc, k) => {
      acc[k] = as.Address(new Buffer(contractsRaw[k], 'hex'))
      return acc
    }, {}) as Contracts

export const toAccount = (acc: { privateKey: string }): AccountBase => {
  const privateKeyStr = util.stripHexPrefix(acc.privateKey)
  const privateKey = as.PrivateKey(new Buffer(privateKeyStr, 'hex'))
  const addressStr = util.privateToAddress(privateKey).toString('hex')
  return {
    addressStr,
    privateKeyStr,
    addressShort: shortAddress(addressStr),
    address: as.Address(new Buffer(addressStr, 'hex')),
    privateKey
  }
}

const shortAddress = (a: string) => '0x' + a.substring(0, 16) + '...'

const weiToEthString = (w: Wei) => w.div(new BN('1000000000000000000')).toString()

const collectEvents = (evs: Observable<any>) =>
  evs
    .scan((a, e) => a.concat([e]), [])
    .shareReplay(1)

const createP2PProxy = (p2p: P2P) => {
  let mode: P2PMode = 'normal'
  const messages = new BehaviorSubject<Array<[Address, message.SignedMessage]>>([])

  const flush = () => {
    // console.log('MESSAGES', messages.value)
    messages.value.forEach(([t, m]) => p2p.send(t.toString('hex'), message.serialize(m)))
    messages.next([])
  }

  return {
    messages,
    getMode: () => mode,
    setMode: (m: P2PMode) => {
      flush()
      mode = m
    },
    send: (to: Address, msg: message.SignedMessage) => {
      // console.log('SEND', to, msg)
      return mode === 'normal' ?
        p2p.send(to.toString('hex'), message.serialize(msg)) :
        messages.next(messages.value.concat([[to, msg]])) as undefined || Promise.resolve(false)
    },
    flush
  }
}

const initAccount = (cfg: UserSession, contracts: Contracts) => (account: AccountBase) => {

  const p2p = new P2P({
    mqttUrl: cfg.mqttUrl,
    address: account.addressStr,
    storage: fakeStorage()
  })

  const p2pProxy = createP2PProxy(p2p)

  const blockchain = serviceCreate({
    ...contracts,
    chainId: CHAIN_ID.GETH_PRIVATE_CHAINS,
    owner: account.address,
    signatureCb: (cb) => cb(account.privateKey),
    providerUrl: cfg.ethUrl,
    monitoringConfig: {
      startBlock: 'latest', // 'earliest' would be more appropraite to reconstruct the state, but then we need persitence
      logsInterval: cfg.blockTime // cfg.blockTime
    }
  })

  const engine = new Engine({
    address: account.address,
    sign: (msg) => msg.sign(account.privateKey),
    send: p2pProxy.send,
    blockchain: blockchain,
    // todo: make if configurable - another thing is that engine assumes single value for all contracts
    settleTimeout: timeouts.settle,
    revealTimeout: timeouts.reveal
  })

  const events = collectEvents(Observable.merge(
    blockchain.monitoring.asStream('*').map(e => {
      return {
        block: blockchain.monitoring.blockNumber()!.toNumber(),
        at: Date.now(),
        source: EventSource.Blockchain,
        event: e
      } as Event
    }),
    Observable.fromEvent(p2p, 'message-received').map(e => {
      return {
        at: Date.now(),
        block: blockchain.monitoring.blockNumber()!.toNumber(),
        source: EventSource.P2P,
        event: e
      } as Event
    }),
    // FIXME - remove
    blockchain.monitoring.blockNumbers()
      .map(bn => ({
        at: Date.now(),
        source: EventSource.BlockNumber,
        event: bn.toNumber()
      } as any))
  )) as Observable<Array<Event>> // todo: improve typing

  // do not loose any event
  const sub = events
    .subscribe()
  sub.add(blockchain.monitoring.blockNumbers()
    .do(bn => engine.onBlock(bn))
    .subscribe()
  )

  blockchain.monitoring.on('*', engine.onBlockchainEvent)
  p2p.on('message-received', msg => engine.onMessage(message.deserializeAndDecode(msg) as any))

  p2p.on('message-received', msg => {
    const m = message.deserializeAndDecode(msg) as any
    console.log('p2p', account.addressStr, m.classType, engine.channels)
  })

  p2p.on('callback-error', err => {
    console.warn('P2P:emit-error', account.addressStr, err)
  })

  return Observable.zip(
    Observable.fromEvent(p2p, 'status-changed')
      .filter(s => s === 'connected')
      .take(1)
      .do(x => console.log('CONNECTED')),
    Observable.defer(() => blockchain.rpc.blockNumber())
      .do(x => console.log('BLOCK-NUMBER', x.toString()))
      .take(1),
    Observable.defer(() => blockchain.rpc.getBalance({ address: account.address }))
      .do(x => console.log('BALANCE', x.toString(), account.addressStr))
  )
    .mapTo({
      contracts, p2p, engine, blockchain, owner: account, txs: blockchain.txs,
      balance: balance(blockchain),
      events,
      dispose: () => {
        p2p.dispose()
        blockchain.monitoring.dispose()
        sub.unsubscribe()
      },
      p2pProxy
    })
}

const userSession = () => (session
  .filter(Boolean) as Observable<UserSession>)
  .takeUntil(session.filter(x => !x))
  .do(x => setWaitForDefault({ interval: Math.min(x.blockTime / 2, 1000), timeout: Math.max(3000, x.blockTime * 3) }))
  .do(x => console.log('config', x))
  .shareReplay(1)

export const accounts = () => {
  const inited: Account[] = []
  return userSession()
    .switchMap((cfg) =>
      Observable.from(cfg.userAccounts
        .filter(a => !inited.find(i => i.owner.addressStr === a.address))
        .map(a => toAccount(a)))
        .mergeMap(initAccount(cfg, toContracts(cfg.contracts)))
        .do(a => inited.push(a))
        .merge(Observable.from(inited))
        .toArray()
        // TODO: remove - it automatically opens netting channels
        // .do((ar) => {
        //   if (ar && ar.length === 2) {
        //     const [a, b, c] = ar
        //     // a.p2pProxy.setMode('manual')
        //     openChannelAndDeposit(a, as.Wei(1000), b.owner.address, () => null)
        //     //  .then(() => openChannelAndDeposit(a, as.Wei(1000), c.owner.address, () => null))
        //   }
        // })
    )
    // .do(x => console.log('USER-ACCOUNTS', x))
    .shareReplay(1)
}

export const otherAccounts = () => userSession()
  .map(s => (s.addresses || []).map(a => ({
    address: new Buffer(a, 'hex'),
    addressStr: a,
    addressShort: shortAddress(a)
  } as OtherAccount)))
  // .do(x => console.log('OTHER-ADDRESSES', x))
  .shareReplay(1)

const isBalanceChanged = (a: AccountBalance, b: AccountBalance) =>
  !(['gotToken', 'hsToken', 'wei'] as Array<keyof AccountBalance>).reduce((v, k) =>
    v || !a[k].eq(b[k]), false)

const balance = (blockchain: ReturnType<typeof serviceCreate>) =>
  blockchain.monitoring.blockNumbers()
    .switchMap(bn =>
      Observable.zip(
        blockchain.contractsProxy.call.token.balanceOf({ to: blockchain.config.gotToken }, { _owner: blockchain.config.owner }),
        blockchain.contractsProxy.call.token.balanceOf({ to: blockchain.config.testToken }, { _owner: blockchain.config.owner }),
        blockchain.rpc.getBalance({ address: blockchain.config.owner }),
        (gotToken, hsToken, wei) => ({ gotToken, hsToken, wei, blockNumber: bn } as AccountBalance)
      ).take(1)
        .map(bl => ({
          ...bl,
          eth: weiToEthString(bl.wei),
          got: bl.gotToken.toString(10),
          hs: bl.hsToken.toString(10),
          delta: {}
        }) as AccountBalanceFormatted)
    )
    .startWith(undefined)
    .shareReplay(1)

export const balances = (accs: ReturnType<typeof accounts>) =>
  accs
    .mergeMap(x => x)
    .mergeMap(acc =>
      (acc.balance
        .filter(Boolean) as Observable<AccountBalanceFormatted>)
        .distinctUntilChanged(isBalanceChanged)
        .startWith(undefined)
        .pairwise()
        .switchMap(([a, b]) => {
          if (a && b) {
            const d = Object.assign({}, b, {
              delta: {
                eth: !a.wei.eq(b.wei) ? weiToEthString(as.Wei(b.wei.sub(a.wei))) : undefined,
                got: !a.gotToken.eq(b.gotToken) ? b.gotToken.sub(a.gotToken).toString() : undefined,
                hs: !a.hsToken.eq(b.hsToken) ? b.hsToken.sub(a.hsToken).toString() : undefined
              }
            }) as AccountBalanceFormatted
            ['eth', 'got', 'hs'].forEach(k => d.delta[k] && d.delta[k][0] !== '-' && (d.delta[k] = '+' + d.delta[k]))
            return Observable.of(b).delay(5000).startWith(d)
          } else {
            return Observable.of(b)
          }
        })
        .startWith(undefined)
        .map(b => ({ [acc.owner.addressStr]: b }))
    )
    .scan((bs, b) => Object.assign({}, bs, b), {})
