const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js')
const { createClient } = require('@supabase/supabase-js')
const http = require('http')
require('dotenv').config()

// HTTPサーバーの設定
const server = http.createServer((req, res) => {
  res.writeHead(200)
  res.end('Discord bot is running!')
})

const port = process.env.PORT || 3000
server.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message]
})

// データベース操作の関数
async function getOrCreateUser(discordId) {
  let { data: user } = await supabase.from('users').select('id, discord_id').eq('discord_id', discordId).single()

  if (!user) {
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert([{ discord_id: discordId }])
      .select()
      .single()

    if (userError) throw userError
    user = newUser

    // ウォレット作成
    const { error: walletError } = await supabase.from('wallets').insert([{ user_id: user.id }])
    if (walletError) throw walletError

    // ポイントウォレット作成
    const { error: pointWalletError } = await supabase.from('point_wallets').insert([{ user_id: user.id }])
    if (pointWalletError) throw pointWalletError
  }

  return user
}

async function getOrCreatePointWallet(userId) {
  let { data: wallet } = await supabase.from('point_wallets').select('*').eq('user_id', userId).single()

  if (!wallet) {
    const { data: newWallet, error } = await supabase
      .from('point_wallets')
      .insert([{ user_id: userId, points: 0 }])
      .select()
      .single()

    if (error) throw error
    wallet = newWallet
  }

  return wallet
}

async function getUserInventory(userId) {
  try {
    // コインウォレット情報を取得
    const { data: wallet } = await supabase.from('wallets').select('coins').eq('user_id', userId).single()

    // ポイントウォレットを取得または作成
    const { data: pointWallet } = await getOrCreatePointWallet(userId)

    // アイテム情報を取得
    const { data: items } = await supabase
      .from('user_items')
      .select(
        `
        quantity,
        items (
          name,
          price
        )
      `
      )
      .eq('user_id', userId)

    return {
      coins: wallet?.coins || 0,
      points: pointWallet?.points || 0,
      items: items || []
    }
  } catch (error) {
    console.error('Error getting user inventory:', error)
    throw error
  }
}

// 購入処理中フラグを管理するMap
const processingPurchases = new Map()

async function purchaseItem(userId, itemId) {
  const purchaseKey = `${userId}-${itemId}`
  if (processingPurchases.get(purchaseKey)) {
    return { success: false, message: '前回の購入処理が完了していません。少々お待ちください。' }
  }

  processingPurchases.set(purchaseKey, true)

  try {
    const { data: item } = await supabase.from('items').select('id, name, price').eq('id', itemId).single()

    console.log('Purchasing item:', {
      itemId,
      itemName: item.name,
      itemPrice: item.price
    })

    const { data: wallet } = await supabase.from('wallets').select('coins').eq('user_id', userId).single()

    console.log('Current wallet:', {
      userId,
      currentCoins: wallet.coins,
      deduction: item.price
    })

    if (wallet.coins < item.price) {
      return { success: false, message: 'コインが不足しています' }
    }

    const { data: userItem } = await supabase
      .from('user_items')
      .select('quantity')
      .eq('user_id', userId)
      .eq('item_id', itemId)
      .single()

    const { error: walletError, data: updatedWallet } = await supabase
      .from('wallets')
      .update({ coins: wallet.coins - item.price })
      .eq('user_id', userId)
      .select()
      .single()

    if (walletError) throw walletError

    const newQuantity = userItem ? userItem.quantity + 1 : 1

    const { error: itemError } = await supabase.from('user_items').upsert(
      {
        user_id: userId,
        item_id: itemId,
        quantity: newQuantity,
        updated_at: new Date().toISOString()
      },
      {
        onConflict: 'user_id,item_id'
      }
    )

    if (itemError) throw itemError

    console.log('Purchase completed:', {
      userId,
      itemName: item.name,
      finalCoins: updatedWallet.coins
    })

    return {
      success: true,
      message: `${item.name}を購入しました！\n残りコイン: ${updatedWallet.coins}`
    }
  } catch (error) {
    console.error('Purchase error details:', error)
    throw error
  } finally {
    processingPurchases.delete(purchaseKey)
  }
}

async function addPoints(userId, amount, grantedBy) {
  const { data: wallet } = await getOrCreatePointWallet(userId)

  const { error: updateError } = await supabase
    .from('point_wallets')
    .update({
      points: wallet.points + amount,
      updated_at: new Date().toISOString()
    })
    .eq('user_id', userId)

  if (updateError) throw updateError

  const { error: historyError } = await supabase.from('point_transactions').insert([
    {
      user_id: userId,
      amount: amount,
      granted_by: grantedBy
    }
  ])

  if (historyError) throw historyError
}

// メッセージハンドラーの重複防止
const messageHandlers = new Map()

client.on('messageCreate', async (message) => {
  // 重複防止のためのチェック
  if (messageHandlers.has(message.id)) return
  messageHandlers.set(message.id, true)

  // 5分後にメッセージIDを削除（メモリ管理）
  setTimeout(() => messageHandlers.delete(message.id), 300000)

  if (message.author.bot) return

  if (message.content === '!shop') {
    try {
      const { data: items } = await supabase.from('items').select('*')

      const shopButtons = items.map((item) =>
        new ButtonBuilder()
          .setCustomId(`buy_${item.id}`)
          .setLabel(`${item.name} - ${item.price}コイン`)
          .setStyle(ButtonStyle.Primary)
      )

      const inventoryButton = new ButtonBuilder()
        .setCustomId('show_inventory')
        .setLabel('🎒 インベントリを表示')
        .setStyle(ButtonStyle.Secondary)

      const shopRow = new ActionRowBuilder().addComponents(shopButtons)
      const inventoryRow = new ActionRowBuilder().addComponents(inventoryButton)

      const embed = new EmbedBuilder()
        .setTitle('🛍️ ショップ')
        .setDescription('アイテムを購入するか、インベントリを確認できます')
        .setColor('#00ff00')

      await message.channel.send({
        embeds: [embed],
        components: [shopRow, inventoryRow]
      })
    } catch (error) {
      console.error('Shop command error:', error)
      await message.channel.send('ショップの表示中にエラーが発生しました。')
    }
  }

  if (message.content.startsWith('!addpoints')) {
    try {
      const allowedChannelId = process.env.ALLOWED_CHANNEL_ID
      if (message.channel.id !== allowedChannelId) {
        await message.reply('このコマンドは指定されたチャンネルでのみ使用できます。')
        return
      }

      const args = message.content.split(' ')
      if (args.length !== 3) {
        await message.reply('使用方法: !addpoints @ユーザー 金額')
        return
      }

      const targetUser = message.mentions.users.first()
      if (!targetUser) {
        await message.reply('ポイントを付与するユーザーを指定してください。')
        return
      }

      const amount = parseInt(args[2])
      if (isNaN(amount) || amount <= 0) {
        await message.reply('有効な金額を指定してください。')
        return
      }

      const user = await getOrCreateUser(targetUser.id)
      await addPoints(user.id, amount, message.author.id)

      const embed = new EmbedBuilder()
        .setTitle('✨ ポイント付与')
        .setDescription(`${targetUser.toString()} に ${amount} ポイントを付与しました！`)
        .setColor('#00ff00')

      await message.channel.send({
        embeds: [embed]
      })
    } catch (error) {
      console.error('Points addition error:', error)
      await message.channel.send('ポイントの付与中にエラーが発生しました。')
    }
  }
})

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return

  try {
    await interaction.deferReply({ ephemeral: true })

    if (interaction.customId === 'show_inventory') {
      const user = await getOrCreateUser(interaction.user.id)
      const inventory = await getUserInventory(user.id)
      const itemsList = inventory.items.map((item) => `${item.items.name}: ${item.quantity}個`).join('\n')

      const inventoryEmbed = new EmbedBuilder()
        .setTitle('🎒 インベントリ')
        .setDescription(
          `💰 コイン: ${inventory.coins}\n` +
            `🏆 ポイント: ${inventory.points}\n\n` +
            `【所持アイテム】\n${itemsList || 'アイテムがありません'}`
        )
        .setColor('#ffd700')
        .setThumbnail(interaction.user.displayAvatarURL())

      await interaction.editReply({
        embeds: [inventoryEmbed]
      })
    } else if (interaction.customId.startsWith('buy_')) {
      const itemId = interaction.customId.split('_')[1]
      const user = await getOrCreateUser(interaction.user.id)
      const result = await purchaseItem(user.id, itemId)

      const responseEmbed = new EmbedBuilder()
        .setTitle(result.success ? '✅ 購入成功' : '❌ 購入失敗')
        .setDescription(result.message)
        .setColor(result.success ? '#00ff00' : '#ff0000')

      await interaction.editReply({
        embeds: [responseEmbed]
      })
    }
  } catch (error) {
    console.error('Button interaction error:', error)
    await interaction.editReply({
      content: 'エラーが発生しました。',
      ephemeral: true
    })
  }
})

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`)
})

client.on('error', (error) => {
  console.error('Discord client error:', error)
})

client.login(process.env.DISCORD_TOKEN)
