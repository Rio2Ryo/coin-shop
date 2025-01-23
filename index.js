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
const VoteHandler = require('./voteHandler')
const ChannelHandler = require('./channelHandler')
const CommandHandler = require('./commandHandler')
require('dotenv').config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

const voteHandler = new VoteHandler(supabase)
const channelHandler = new ChannelHandler(supabase)
const commandHandler = new CommandHandler(supabase)

// HTTPサーバーの設定
const server = http.createServer((req, res) => {
  res.writeHead(200)
  res.end('Discord bot is running!')
})

const port = process.env.PORT || 3000
server.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})

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

    const { error: walletError } = await supabase.from('wallets').insert([{ user_id: user.id }])
    if (walletError) throw walletError
  }

  return user
}

async function getUserInventory(userId) {
  try {
    const { data: wallet } = await supabase.from('wallets').select('coins').eq('user_id', userId).single()

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
      return { success: false, message: 'FBPが不足しています' }
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
      message: `${item.name}を購入しました！\n残りFBP: ${updatedWallet.coins}`
    }
  } catch (error) {
    console.error('Purchase error details:', error)
    throw error
  } finally {
    processingPurchases.delete(purchaseKey)
  }
}

async function addFBP(userId, amount, grantedBy) {
  try {
    // FBPを追加
    const { data: wallet } = await supabase.from('wallets').select('coins').eq('user_id', userId).single()

    const { error: updateError } = await supabase
      .from('wallets')
      .update({
        coins: wallet.coins + amount,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)

    if (updateError) throw updateError

    // トランザクション履歴を記録
    const { error: transactionError } = await supabase.from('fbp_transactions').insert([
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

// メッセージハンドラーの重複防止
const messageHandlers = new Map()

client.on('messageCreate', async (message) => {
  if (messageHandlers.has(message.id)) return
  messageHandlers.set(message.id, true)
  setTimeout(() => messageHandlers.delete(message.id), 300000)

  if (message.author.bot) return

  /*
  // コマンドの場合は管理者権限をチェック
  if (message.content.startsWith('!')) {
    // 管理者でない場合は何もせずに終了
    if (!message.member.permissions.has('Administrator')) {
      return
    }
  }
  */

  // コマンドと管理者権限のチェック
  if (message.content.startsWith('!')) {
    const args = message.content.slice(1).trim().split(/\s+/)
    const command = args.shift().toLowerCase()

    // 管理者専用コマンド
    if (!message.member.permissions.has('Administrator')) {
      return
    }

    // コマンドの処理
    switch (command) {
      case 'shop':
        await commandHandler.handleShop(message)
        break
      case 'getfbp':
        await commandHandler.handleGetFBP(message, args)
        break
      case 'inventory':
        await commandHandler.handleInventory(message)
        break
      case 'addfbp':
        await commandHandler.handleAddFBP(message, args)
        break
      case 'quests':
        await commandHandler.listQuests(message)
        break
      case 'addquest':
        await commandHandler.addQuest(message, args)
        break
      case 'editquest':
        await commandHandler.editQuest(message, args)
        break
      case 'deletequest':
        await commandHandler.deleteQuest(message, args)
        break
      case 'items':
        await commandHandler.listItems(message)
        break
      case 'additem':
        await commandHandler.addItem(message, args)
        break
      case 'edititem':
        await commandHandler.editItem(message, args)
        break
      case 'deleteitem':
        await commandHandler.deleteItem(message, args)
        break
      case 'help':
        await commandHandler.handleHelp(message)
        break
    }
  }

  /*
  if (message.content === '!shop') {
    try {
      const { data: items } = await supabase.from('items').select('*')

      const shopButtons = items.map((item) =>
        new ButtonBuilder()
          .setCustomId(`buy_${item.id}`)
          .setLabel(`${item.name} - ${item.price}FBP`)
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

  if (message.content.startsWith('!getfbp')) {
    try {
      const args = message.content
        .trim()
        .split(/\s+/)
        .filter((arg) => arg.length > 0)

      if (args.length !== 2) {
        await message.reply('使用方法: !getfbp [@メンション または ユーザーID]')
        return
      }

      let targetUserId
      const mentionedUser = message.mentions.users.first()

      if (mentionedUser) {
        targetUserId = mentionedUser.id
      } else {
        targetUserId = args[1]
        if (!/^\d+$/.test(targetUserId)) {
          await message.reply('有効なユーザーIDまたはメンションを指定してください。')
          return
        }
      }

      const user = await getOrCreateUser(targetUserId)
      const { data: wallet } = await supabase.from('wallets').select('coins').eq('user_id', user.id).single()

      const embed = new EmbedBuilder()
        .setTitle('💰 FBP残高照会')
        .setDescription(`ユーザーID: ${targetUserId}\n残高: ${wallet.coins} FBP`)
        .setColor('#00ff00')

      await message.channel.send({
        embeds: [embed]
      })
    } catch (error) {
      console.error('FBP reference error:', error)
      await message.channel.send('FBPの照会中にエラーが発生しました。')
    }
  }

  if (message.content === '!inventory') {
    try {
      const inventoryButton = new ButtonBuilder()
        .setCustomId('show_inventory')
        .setLabel('🎒 インベントリを表示する')
        .setStyle(ButtonStyle.Secondary)

      const row = new ActionRowBuilder().addComponents(inventoryButton)

      const embed = new EmbedBuilder()
        .setTitle('🎒 インベントリ確認')
        .setDescription('インベントリを表示して自分のポイントと所持アイテムを確認する')
        .setColor('#ffd700')

      await message.channel.send({
        embeds: [embed],
        components: [row]
      })
    } catch (error) {
      console.error('Inventory command error:', error)
      await message.channel.send('インベントリの表示中にエラーが発生しました。')
    }
  }

  if (message.content.startsWith('!addfbp')) {
    try {
      const args = message.content
        .trim()
        .split(/\s+/)
        .filter((arg) => arg.length > 0)
      console.log('Command args:', args)

      if (args.length !== 3) {
        await message.reply('使用方法: !addfbp [@メンション または ユーザーID] [金額]')
        return
      }

      let targetUserId
      const mentionedUser = message.mentions.users.first()

      if (mentionedUser) {
        targetUserId = mentionedUser.id
      } else {
        targetUserId = args[1]
        if (!/^\d+$/.test(targetUserId)) {
          await message.reply('有効なユーザーIDまたはメンションを指定してください。')
          return
        }
      }

      const amount = parseInt(args[2])
      if (isNaN(amount) || amount <= 0) {
        await message.reply('有効な金額を指定してください。')
        return
      }

      const user = await getOrCreateUser(targetUserId)
      await addFBP(user.id, amount, message.author.id)

      const embed = new EmbedBuilder()
        .setTitle('✨ FBP付与')
        .setDescription(`ユーザーID: ${targetUserId} に ${amount} FBPを付与しました！`)
        .setColor('#00ff00')

      await message.channel.send({
        embeds: [embed]
      })
    } catch (error) {
      console.error('FBP addition error:', error)
      await message.channel.send('FBPの付与中にエラーが発生しました。')
    }
  }
  */

  // 投票機能の処理を追加
  await voteHandler.handleMessage(message, process.env.VOTE_CHANNEL_ID)
})

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return

  // 既知のボタンIDのリスト（固定値として定義）
  const validButtonIds = [
    'show_inventory',
    'buy_', // 購入ボタンのプレフィックス
    'vote_' // 投票ボタンのプレフィックス
  ]

  // 未知のボタンIDは無視
  if (!validButtonIds.some((id) => interaction.customId === id || interaction.customId.startsWith(id))) {
    return
  }

  try {
    // 投票ボタンの処理
    if (interaction.customId.startsWith('vote_')) {
      await voteHandler.handleVote(interaction)
      return
    }

    await interaction.deferReply({ ephemeral: true })

    if (interaction.customId === 'show_inventory') {
      const user = await getOrCreateUser(interaction.user.id)
      const inventory = await getUserInventory(user.id)
      const itemsList = inventory.items.map((item) => `${item.items.name}: ${item.quantity}個`).join('\n')

      const inventoryEmbed = new EmbedBuilder()
        .setTitle('🎒 インベントリ')
        .setDescription(`💰 FBP: ${inventory.coins}\n\n` + `【所持アイテム】\n${itemsList || 'アイテムがありません'}`)
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

client.on('channelUpdate', async (oldChannel, newChannel) => {
  if (oldChannel.name !== newChannel.name) {
    await channelHandler.handleChannelUpdate(
      newChannel,
      process.env.REPORT_CHANNEL_ID,
      process.env.NOTIFICATION_CHANNEL_ID,
      'update'
    )
  }
})

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`)
})

client.on('error', (error) => {
  console.error('Discord client error:', error)
})

client.login(process.env.DISCORD_TOKEN)
