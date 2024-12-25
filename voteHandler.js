const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js')

class VoteHandler {
  constructor(supabase) {
    this.supabase = supabase
  }

  // 投票数を取得する関数
  async getVoteCount(messageId) {
    try {
      const { count } = await this.supabase
        .from('item_usage_history')
        .select('*', { count: 'exact' })
        .eq('target_message_id', messageId)
        .eq('action_type', 'vote')

      return count || 0
    } catch (error) {
      console.error('Error getting vote count:', error)
      return 0
    }
  }

  // メッセージを処理し、投票ボタンを追加
  async handleMessage(message, targetChannelId) {
    if (message.channelId !== targetChannelId) return
    if (message.author.bot) return

    try {
      const voteButton = new ButtonBuilder()
        .setCustomId(`vote_${message.id}`)
        .setLabel('投票する')
        .setStyle(ButtonStyle.Primary)

      const row = new ActionRowBuilder().addComponents(voteButton)

      // 初期投票数を取得
      const initialCount = await this.getVoteCount(message.id)

      const embed = new EmbedBuilder()
        .setColor('#00ff00')
        .addFields({ name: '現在の投票数', value: `${initialCount}票` })

      await message.reply({
        embeds: [embed],
        components: [row]
      })
    } catch (error) {
      console.error('Error creating vote message:', error)
    }
  }

  // 投票ボタンが押された時の処理
  async handleVote(interaction) {
    if (!interaction.customId.startsWith('vote_')) return

    await interaction.deferReply({ ephemeral: true })

    try {
      const messageId = interaction.customId.split('_')[1]
      const user = await this.getOrCreateUser(interaction.user.id)

      // 投票対象のメッセージを取得
      const targetMessage = await interaction.message.fetchReference()
      const messageLink = `https://discord.com/channels/${interaction.guildId}/${targetMessage.channelId}/${targetMessage.id}`

      // ユーザーの投票券を確認
      const { data: userItems } = await this.supabase
        .from('user_items')
        .select('quantity, items(id, name)')
        .eq('user_id', user.id)
        .eq('items.name', '投票券')
        .single()

      if (!userItems || userItems.quantity < 1) {
        await interaction.editReply('投票券を持っていません。')
        return
      }

      // トランザクション的な処理
      // 1. 投票券を消費
      const { error: itemError } = await this.supabase
        .from('user_items')
        .update({
          quantity: userItems.quantity - 1,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', user.id)
        .eq('item_id', userItems.items.id)

      if (itemError) throw itemError

      // 2. 使用履歴を記録
      const { error: usageError } = await this.supabase.from('item_usage_history').insert([
        {
          user_id: user.id,
          item_id: userItems.items.id,
          target_message_id: messageId,
          action_type: 'vote'
        }
      ])

      if (usageError) throw usageError

      // データベースから最新の投票数を取得
      const currentVotes = await this.getVoteCount(messageId)

      // メッセージを更新
      const message = await interaction.message
      const embed = EmbedBuilder.from(message.embeds[0]).spliceFields(0, 1, {
        name: '現在の投票数',
        value: `${currentVotes}票`
      })

      await message.edit({ embeds: [embed] })

      // 投票完了メッセージ（メッセージリンク付き）
      await interaction.editReply(`[このメッセージ](${messageLink})に投票しました！`)
    } catch (error) {
      console.error('Vote error:', error)
      await interaction.editReply('投票処理中にエラーが発生しました。')
    }
  }

  // ユーザー取得もしくは作成
  async getOrCreateUser(discordId) {
    try {
      let { data: user } = await this.supabase
        .from('users')
        .select('id, discord_id')
        .eq('discord_id', discordId)
        .single()

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
    } catch (error) {
      console.error('Error in getOrCreateUser:', error)
      throw error
    }
  }
}

module.exports = VoteHandler
