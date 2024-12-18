const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder
} = require('discord.js')
const { createClient } = require('@supabase/supabase-js')
const path = require('path')
require('dotenv').config()

const http = require('http')

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
  // ユーザー取得
  let { data: user } = await supabase.from('users').select('id, discord_id').eq('discord_id', discordId).single()

  // ユーザーが存在しない場合は作成
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
  }

  return user
}

async function getUserInventory(userId) {
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
}

// 購入処理中フラグを管理するMap
const processingPurchases = new Map()

async function purchaseItem(userId, itemId) {
  // 同じユーザーの同時購入を防ぐ
  const purchaseKey = `${userId}-${itemId}`
  if (processingPurchases.get(purchaseKey)) {
    return { success: false, message: '前回の購入処理が完了していません。少々お待ちください。' }
  }

  processingPurchases.set(purchaseKey, true)

  try {
    // アイテムの価格を取得
    const { data: item } = await supabase.from('items').select('id, name, price').eq('id', itemId).single()

    console.log('Purchasing item:', {
      itemId,
      itemName: item.name,
      itemPrice: item.price
    })

    // ウォレット情報を取得
    const { data: wallet } = await supabase.from('wallets').select('coins').eq('user_id', userId).single()

    console.log('Current wallet:', {
      userId,
      currentCoins: wallet.coins,
      deduction: item.price
    })

    if (wallet.coins < item.price) {
      return { success: false, message: 'コインが不足しています' }
    }

    // 現在のアイテム数を取得
    const { data: userItem } = await supabase
      .from('user_items')
      .select('quantity')
      .eq('user_id', userId)
      .eq('item_id', itemId)
      .single()

    // コインを減少（一度だけ）
    const { error: walletError, data: updatedWallet } = await supabase
      .from('wallets')
      .update({ coins: wallet.coins - item.price })
      .eq('user_id', userId)
      .select()
      .single()

    if (walletError) throw walletError

    // 新しい数量を計算（既存のアイテムがなければ1、あれば+1）
    const newQuantity = userItem ? userItem.quantity + 1 : 1

    // アイテム数を更新
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
    // 処理完了後にフラグを解除
    processingPurchases.delete(purchaseKey)
  }
}

client.on('interactionCreate', async (interaction) => {
  // ボタンのインタラクションでない場合は無視
  if (!interaction.isButton()) return

  try {
    // 応答を遅延させる（処理に時間がかかる可能性があるため）
    await interaction.deferReply({ ephemeral: true })

    // 購入ボタンが押された場合
    if (interaction.customId.startsWith('buy_')) {
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
    // インベントリ表示ボタンが押された場合
    else if (interaction.customId === 'show_inventory') {
      const user = await getOrCreateUser(interaction.user.id)
      const inventory = await getUserInventory(user.id)
      const itemsList = inventory.items.map((item) => `${item.items.name}: ${item.quantity}個`).join('\n')

      // 画像の準備（存在する場合）
      let files = []
      try {
        const bannerPath = path.join(__dirname, 'assets', 'inventory-banner.png')
        const bannerAttachment = new AttachmentBuilder(bannerPath)
        files.push(bannerAttachment)
      } catch (error) {
        console.error('Banner image not found:', error)
        // 画像がない場合は空の配列のまま続行
      }

      const inventoryEmbed = new EmbedBuilder()
        .setColor('#ffd700')
        .setTitle('🎒 インベントリ')
        .setDescription(`💰 コイン: ${inventory.coins}\n\n【所持アイテム】\n${itemsList || 'アイテムがありません'}`)
        .setThumbnail(interaction.user.displayAvatarURL())

      // 画像が存在する場合のみsetImageを設定
      if (files.length > 0) {
        inventoryEmbed.setImage('attachment://inventory-banner.png')
      }

      await interaction.editReply({
        embeds: [inventoryEmbed],
        files: files // 画像があれば添付、なければ空配列
      })
    }
  } catch (error) {
    console.error('Interaction error:', error)

    // エラー発生時のユーザーへの通知
    try {
      await interaction.editReply({
        content: 'エラーが発生しました。しばらく待ってから再度お試しください。',
        ephemeral: true
      })
    } catch (e) {
      console.error('Error while sending error message:', e)
    }
  }
})

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`)
})

client.on('messageCreate', async (message) => {
  if (message.author.bot) return

  if (message.content === '!shop') {
    try {
      const { data: items } = await supabase.from('items').select('*')

      // 商品購入ボタンの作成
      const shopButtons = items.map((item) =>
        new ButtonBuilder()
          .setCustomId(`buy_${item.id}`)
          .setLabel(`${item.name} - ${item.price}コイン`)
          .setStyle(ButtonStyle.Primary)
      )

      // インベントリ表示ボタン
      const inventoryButton = new ButtonBuilder()
        .setCustomId('show_inventory')
        .setLabel('🎒 インベントリを表示')
        .setStyle(ButtonStyle.Secondary)

      // ボタンを行に分けて配置
      const shopRow = new ActionRowBuilder().addComponents(shopButtons)
      const inventoryRow = new ActionRowBuilder().addComponents(inventoryButton)

      // 画像の準備
      const shopBannerPath = path.join(__dirname, 'assets', 'shop-banner.png')
      const shopBannerAttachment = new AttachmentBuilder(shopBannerPath)

      const embed = new EmbedBuilder()
        .setColor('#00ff00')
        .setImage('attachment://shop-banner.png')
        .setTitle('🛍️ ショップ')
        .setDescription('アイテムを購入するか、インベントリを確認できます')

      await message.channel.send({
        embeds: [embed],
        files: [shopBannerAttachment], // ここで画像を添付
        components: [shopRow, inventoryRow]
      })
    } catch (error) {
      console.error('Shop command error:', error)
      await message.channel.send('ショップの表示中にエラーが発生しました。')
    }
  }
})

client.on('error', (error) => {
  console.error('Discord client error:', error)
})

client.login(process.env.DISCORD_TOKEN)
