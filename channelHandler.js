const { EmbedBuilder } = require('discord.js')

class ChannelHandler {
  constructor(supabase) {
    this.supabase = supabase
    this.REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID
    this.NOTIFICATION_CHANNEL_ID = process.env.NOTIFICATION_CHANNEL_ID
    this.FBP_AMOUNT = 100
  }

  async handleChannelUpdate(channel, action) {
    // チャンネルが指定されたカテゴリに属していない場合は処理しない
    if (channel.parentId !== this.REPORT_CHANNEL_ID) return

    const channelName = channel.name
    // 「報告*完了-*」のパターンにマッチするか確認
    const reportCompletePattern = /^報告(.*)完了-(.*?)$/
    const match = channelName.match(reportCompletePattern)

    if (!match) return

    const reportNumber = match[1] // 報告番号（例：'001'）
    const targetUsername = match[2] // ユーザー名

    try {
      // ユーザーIDの取得
      const guildMembers = await channel.guild.members.fetch()
      const targetMember = guildMembers.find(
        (member) => member.user.username.toLowerCase() === targetUsername.toLowerCase()
      )

      if (!targetMember) {
        console.error(`User ${targetUsername} not found in the server`)
        return
      }

      // 通知チャンネルの取得
      const notificationChannel = channel.parent.children.cache.find(
        (ch) => ch.name === `${targetUsername}-通知チャネル`
      )

      if (!notificationChannel) {
        console.error(`Notification channel for ${targetUsername} not found`)
        return
      }

      // ユーザーの取得または作成
      const user = await this.getOrCreateUser(targetMember.id)

      // FBPの付与
      await this.addFBP(user.id, this.FBP_AMOUNT, 'SYSTEM')

      // 通知の送信
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
