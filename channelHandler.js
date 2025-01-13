const { EmbedBuilder } = require('discord.js')

class ChannelHandler {
  constructor(supabase) {
    this.supabase = supabase
    this.FBP_AMOUNT = 100
    // 最後に処理したチャンネル名とタイムスタンプを保存
    this.lastProcessed = {
      channelName: null,
      timestamp: 0
    }
  }

  async handleChannelUpdate(channel, reportChannelId, notificationChannelId, action) {
    // デバッグ情報を追加
    console.log('=== Channel Update Event Debug Info ===')
    console.log('Channel ID:', channel.id)
    console.log('Channel Name:', channel.name)
    console.log('Parent ID:', channel.parentId)
    console.log('Action:', action)
    console.log('Current Timestamp:', new Date().toISOString())
    console.log('Last Processed:', this.lastProcessed)
    console.log('=====================================')

    // 同じチャンネル名で5秒以内の重複をチェック
    const now = Date.now()
    if (channel.name === this.lastProcessed.channelName && now - this.lastProcessed.timestamp < 5000) {
      console.log('Skipping duplicate processing:', {
        channelName: channel.name,
        timeSinceLastProcess: now - this.lastProcessed.timestamp + 'ms'
      })
      return
    }

    if (channel.parentId !== reportChannelId) {
      console.log('Parent channel ID does not match target ID')
      return
    }

    const channelName = channel.name
    const reportCompletePattern = /^報告(.*)完了-(.*?)$/
    const match = channelName.match(reportCompletePattern)

    if (!match) {
      console.log('Channel name does not match expected pattern')
      return
    }

    // 処理開始前にタイムスタンプを更新
    this.lastProcessed = {
      channelName: channel.name,
      timestamp: now
    }

    const reportNumber = match[1]
    const targetUsername = match[2]

    try {
      const guildMembers = await channel.guild.members.fetch()
      const targetMember = guildMembers.find(
        (member) => member.user.username.toLowerCase() === targetUsername.toLowerCase()
      )

      if (!targetMember) {
        console.error(`User ${targetUsername} not found in the server`)
        return
      }

      // 通知チャンネルを探す
      const notificationChannel = channel.guild.channels.cache
        .filter((ch) => ch.parentId === notificationChannelId)
        .find((ch) => ch.name.toLowerCase() === `${targetUsername.toLowerCase()}-通知チャネル`)

      if (!notificationChannel) {
        console.error(`Notification channel for ${targetUsername} not found`)
        console.log('Looking for:', `${targetUsername.toLowerCase()}-通知チャネル`)
        console.log(
          'Available channels:',
          Array.from(channel.guild.channels.cache.filter((ch) => ch.parentId === notificationChannelId).values()).map(
            (ch) => ch.name
          )
        )
        return
      }

      const user = await this.getOrCreateUser(targetMember.id)
      await this.addFBP(user.id, this.FBP_AMOUNT, 'SYSTEM')

      const embed = new EmbedBuilder()
        .setTitle(`🎉 報告${reportNumber}完了ボーナス`)
        .setDescription(`<@${targetMember.id}>さんに${this.FBP_AMOUNT}FBPが付与されました！`)
        .setColor('#00ff00')
        .setTimestamp()

      await notificationChannel.send({ embeds: [embed] })
    } catch (error) {
      console.error('Error in handleChannelUpdate:', error)
      console.error('Error details:', error.message)
      if (error.stack) console.error('Stack trace:', error.stack)
    }
  }

  async getOrCreateUser(discordId) {
    let { data: user } = await this.supabase.from('users').select('id, discord_id').eq('discord_id', discordId).single()

    if (!user) {
      const { data: newUser, error: userError } = await this.supabase
        .from('users')
        .insert([{ discord_id: discordId }])
        .select()
        .single()

      if (userError) throw userError
      user = newUser

      const { error: walletError } = await this.supabase.from('wallets').insert([{ user_id: user.id }])

      if (walletError) throw walletError
    }

    return user
  }

  async addFBP(userId, amount, grantedBy) {
    try {
      const { data: wallet } = await this.supabase.from('wallets').select('coins').eq('user_id', userId).single()

      const { error: updateError } = await this.supabase
        .from('wallets')
        .update({
          coins: wallet.coins + amount,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)

      if (updateError) throw updateError

      const { error: transactionError } = await this.supabase.from('fbp_transactions').insert([
        {
          user_id: userId,
          amount: amount,
          granted_by: grantedBy
        }
      ])

      if (transactionError) throw transactionError
    } catch (error) {
      console.error('Error in addFBP:', error)
      throw error
    }
  }
}

module.exports = ChannelHandler
