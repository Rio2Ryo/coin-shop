const { EmbedBuilder } = require('discord.js')

class ChannelHandler {
  constructor(supabase) {
    this.supabase = supabase
    this.FBP_AMOUNT = 100
  }

  async handleChannelUpdate(channel, reportChannelId, notificationChannelId, action) {
    if (channel.parentId !== reportChannelId) return

    const channelName = channel.name
    const reportCompletePattern = /^報告(.*)完了-(.*?)$/
    const match = channelName.match(reportCompletePattern)

    if (!match) return

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

      // 先にFBPを付与
      const user = await this.getOrCreateUser(targetMember.id)
      await this.addFBP(user.id, this.FBP_AMOUNT, 'SYSTEM')
      console.log(`Added ${this.FBP_AMOUNT} FBP to user ${targetUsername}`)

      // 通知チャンネルの検索と通知送信を試みる
      const notificationChannel = channel.guild.channels.cache
        .filter((ch) => ch.parentId === notificationChannelId)
        .find((ch) => ch.name.toLowerCase() === `${targetUsername.toLowerCase()}-通知チャネル`)

      if (!notificationChannel) {
        console.error(`Notification channel for ${targetUsername} not found. FBP was still awarded.`)
        return
      }

      // 通知チャンネルが見つかった場合のみ通知を送信
      const embed = new EmbedBuilder()
        .setTitle(`🎉 報告${reportNumber}完了ボーナス`)
        .setDescription(`<@${targetMember.id}>さんに${this.FBP_AMOUNT}FBPが付与されました！`)
        .setColor('#00ff00')
        .setTimestamp()

      await notificationChannel.send({ embeds: [embed] })
    } catch (error) {
      console.error('Error in handleChannelUpdate:', error)
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
