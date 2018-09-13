import * as React from 'react'
import { Subscription } from 'rxjs'
import { View, Text, Button, Alert, ActivityIndicator } from 'react-native'
import { Channel } from 'go-network-framework/lib/state-channel/channel'
import { as, BN } from 'go-network-framework'
import { Wei, BlockNumber } from 'eth-types'

import { sendDirect, sendMediated } from '../logic/offchain-actions'
import { Account } from '../logic/accounts'

interface Lock {
  expiration: BlockNumber
  amount: Wei
  secret: string
  hashLock: Buffer
}

export const OpenLock = (lock: Lock, index: number) =>
  <View key={lock.secret} style={{ paddingLeft: 4 }}>
    <Text style={{ fontWeight: 'bold' }}>{index}.</Text>
    <Text>Expiration: {lock.expiration.toString(10)}</Text>
    <Text>Amount: {lock.amount.toString(10)}</Text>
  </View>

export const State = (p: Channel['myState'] | Channel['peerState'], openLocks?: any[]) =>
  <View style={{ paddingLeft: 12 }}>
    <Text>Initial Deposit: {p.depositBalance.toString(10)}</Text>
    <Text>Transferred Amount: {p.transferredAmount.toString(10)}</Text>
    <Text>Nonce: {p.nonce.toString(10)}</Text>
    {openLocks && <Text>Open Locks (total: {openLocks.length})</Text>}
    {openLocks && openLocks.map((l, i) => OpenLock(l, i))}
  </View>

export interface Props {
  currentBlock: BlockNumber
  account: Account
  channel: Channel
  onSelected: () => void
}

export class ChannelShort extends React.Component<Props> {
  sub?: Subscription

  sendDirect = () => {
    sendDirect(this.props.account, this.props.channel.peerState.address,
      this.props.channel.myState.transferredAmount.add(as.Wei(50)) as Wei)
      .then(() => this.forceUpdate())
  }

  sendMediated = () => {
    sendMediated(this.props.account, this.props.channel.peerState.address, as.Wei(50))
      .then(() => this.forceUpdate())
  }

  close = () =>
    this.props.account.engine.closeChannel(this.props.channel.channelAddress)
      .then(x => console.log('CLOSED', x))

  withdraw = () =>
    this.props.account.engine.withdrawPeerOpenLocks(this.props.channel.channelAddress)
      .then(() => Alert.alert('Open Locks withdrawn - success'))

  settle = () => {
    this.props.account.engine.settleChannel(this.props.channel.channelAddress)
    this.forceUpdate()
  }

  renderActions = () => {
    const ch = this.props.channel

    if (ch.peerState.depositBalance.toNumber() === 0 && ch.myState.depositBalance.toNumber() === 0) {
      return <Text>...waiting for deposit...</Text>
    }

    switch (ch.state) {
      case 'opened': return [
        <Button key='c' title='Close' onPress={this.close} />,
        <Button key='d' title='Send Direct (50)' onPress={this.sendDirect} />,
        <Button key='m' title='Send Mediated (50)' onPress={this.sendMediated} />
      ]
      case 'closed':
        const toSettle = ch.closedBlock!.add(this.props.account.engine.settleTimeout).sub(this.props.currentBlock)
        const canSettle = toSettle.lte(new BN(0))
        const canWithdraw = Object.keys(ch.peerState.openLocks).length > 0
        return [
          <Button key='w' disabled={!canWithdraw} title='Withdraw Peer Open Locks' onPress={this.withdraw} />,
          canSettle ?
            <Button key='s' title='Settle' onPress={this.settle} /> :
            <Text key='s'>Settle possible in {toSettle.toString(10)}</Text>
        ]
      case 'settling': return <Text>...settling...</Text>
      case 'settled': return <Text>Settled - no more actions available</Text>
      default:
        return <ActivityIndicator />
    }
  }

  render () {
    const p = this.props
    const ch = p.channel
    const openLocks = Object.values(ch.peerState.openLocks)
    return <View style={{ padding: 20 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {this.renderActions()}
      </View>
      <Text>State: {ch.state}</Text>
      <Text>Channel Address: 0x{ch.channelAddress.toString('hex')}</Text>
      <Text>Peer Address: 0x{ch.peerState.address.toString('hex')}</Text>
      <Text>Opened Block: {ch.openedBlock.toString(10)}</Text>
      {ch.closedBlock && <Text>Closed Block: {ch.closedBlock.toString(10)}</Text>}

      <Text style={{ fontWeight: 'bold' }}>Peer State</Text>
      {State(ch.peerState, openLocks)}

      <Text style={{ fontWeight: 'bold' }}>Account State</Text>
      {State(ch.myState)}

    </View>
  }
}