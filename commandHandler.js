const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js')

class CommandHandler {
  constructor(supabase) {
    this.supabase = supabase
  }

  async handleHelp(message) {
    try {
      const embed = new EmbedBuilder()
        .setTitle('コマンド一覧')
        .setDescription(
          '`!shop` - ショップを表示します\n' +
            '`!inventory` - インベントリを表示します\n\n' +
            '`!quests` - クエスト一覧を表示\n' +
            '`!addquest <quest_number> <fbp_reward> <title>` - クエストを追加\n' +
            '`!editquest <id> <quest_number> <fbp_reward> <title>` - クエストを編集\n' +
            '`!deletequest <id>` - クエストを削除\n\n' +
            '`!items` - アイテム一覧を表示\n' +
            '`!additem <name> <price>` - アイテムを追加\n' +
            '`!edititem <id> <name> <price>` - アイテムを編集\n' +
            '`!deleteitem <id>` - アイテムを削除\n\n' +
            '`!getfbp <@メンション または ユーザーID>` - FBP残高を確認\n' +
            '`!addfbp <@メンション または ユーザーID> <金額>` - FBPを付与'
        )
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      console.error('Help command error:', error)
      await message.channel.send('コマンド一覧の表示中にエラーが発生しました。')
    }
  }

  // 既存のショップコマンド
  async handleShop(message) {
    try {
      const { data: items } = await this.supabase.from('items').select('*')

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

  // FBP残高照会コマンド
  async handleGetFBP(message, args) {
    try {
      if (args.length !== 1) {
        await message.reply('使用方法: !getfbp [@メンション または ユーザーID]')
        return
      }

      let targetUserId
      const mentionedUser = message.mentions.users.first()

      if (mentionedUser) {
        targetUserId = mentionedUser.id
      } else {
        targetUserId = args[0]
        if (!/^\d+$/.test(targetUserId)) {
          await message.reply('有効なユーザーIDまたはメンションを指定してください。')
          return
        }
      }

      const user = await this.getOrCreateUser(targetUserId)
      const { data: wallet } = await this.supabase.from('wallets').select('coins').eq('user_id', user.id).single()

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

  // インベントリ表示コマンド
  async handleInventory(message) {
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

  // FBP付与コマンド
  async handleAddFBP(message, args) {
    try {
      if (args.length !== 2) {
        await message.reply('使用方法: !addfbp [@メンション または ユーザーID] [金額]')
        return
      }

      let targetUserId
      const mentionedUser = message.mentions.users.first()

      if (mentionedUser) {
        targetUserId = mentionedUser.id
      } else {
        targetUserId = args[0]
        if (!/^\d+$/.test(targetUserId)) {
          await message.reply('有効なユーザーIDまたはメンションを指定してください。')
          return
        }
      }

      const amount = parseInt(args[1])
      if (isNaN(amount) || amount <= 0) {
        await message.reply('有効な金額を指定してください。')
        return
      }

      const user = await this.getOrCreateUser(targetUserId)
      await this.addFBP(user.id, amount, message.author.id)

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

  // クエスト関連のコマンド
  async listQuests(message) {
    try {
      const { data: quests, error } = await this.supabase
        .from('quests')
        .select('id, quest_number, fbp_reward, title')
        .order('quest_number')

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('クエスト一覧')
        .setDescription(
          quests.map((q) => `ID: ${q.id} | No.${q.quest_number} | ${q.fbp_reward}FBP | ${q.title}`).join('\n')
        )
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('クエスト一覧の取得に失敗しました。')
      console.error('Error listing quests:', error)
    }
  }

  async addQuest(message, args) {
    try {
      if (args.length < 3) {
        return message.reply('使用方法: !addquest <quest_number> <fbp_reward> <title>')
      }

      const [questNumber, fbpReward, ...titleParts] = args
      const title = titleParts.join(' ')

      const { error } = await this.supabase.from('quests').insert([
        {
          quest_number: questNumber.padStart(3, '0'),
          fbp_reward: parseInt(fbpReward),
          title
        }
      ])

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('クエスト追加')
        .setDescription(`クエスト${questNumber}を追加しました。`)
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('クエストの追加に失敗しました。')
      console.error('Error adding quest:', error)
    }
  }

  async editQuest(message, args) {
    try {
      if (args.length < 4) {
        return message.reply('使用方法: !editquest <id> <quest_number> <fbp_reward> <title>')
      }

      const [id, questNumber, fbpReward, ...titleParts] = args
      const title = titleParts.join(' ')

      const { error } = await this.supabase
        .from('quests')
        .update({
          quest_number: questNumber.padStart(3, '0'),
          fbp_reward: parseInt(fbpReward),
          title,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('クエスト編集')
        .setDescription(`ID:${id}のクエストを更新しました。`)
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('クエストの編集に失敗しました。')
      console.error('Error editing quest:', error)
    }
  }

  async deleteQuest(message, args) {
    try {
      if (args.length < 1) {
        return message.reply('使用方法: !deletequest <id>')
      }

      const [id] = args
      const { error } = await this.supabase.from('quests').delete().eq('id', id)

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('クエスト削除')
        .setDescription(`ID:${id}のクエストを削除しました。`)
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('クエストの削除に失敗しました。')
      console.error('Error deleting quest:', error)
    }
  }

  // アイテム関連のコマンド
  async listItems(message) {
    try {
      const { data: items, error } = await this.supabase.from('items').select('id, name, price').order('id')

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('アイテム一覧')
        .setDescription(items.map((i) => `ID: ${i.id} | ${i.name} | ${i.price}FBP`).join('\n'))
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('アイテム一覧の取得に失敗しました。')
      console.error('Error listing items:', error)
    }
  }

  async addItem(message, args) {
    try {
      if (args.length < 2) {
        return message.reply('使用方法: !additem <name> <price>')
      }

      const [price, ...nameParts] = args.reverse()
      const name = nameParts.reverse().join(' ')

      const { error } = await this.supabase.from('items').insert([
        {
          name,
          price: parseInt(price)
        }
      ])

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('アイテム追加')
        .setDescription(`${name}を追加しました。`)
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('アイテムの追加に失敗しました。')
      console.error('Error adding item:', error)
    }
  }

  async editItem(message, args) {
    try {
      if (args.length < 3) {
        return message.reply('使用方法: !edititem <id> <name> <price>')
      }

      const [id, price, ...nameParts] = args.reverse()
      const name = nameParts.reverse().join(' ')

      const { error } = await this.supabase
        .from('items')
        .update({
          name,
          price: parseInt(price),
          updated_at: new Date().toISOString()
        })
        .eq('id', id)

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('アイテム編集')
        .setDescription(`ID:${id}のアイテムを更新しました。`)
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('アイテムの編集に失敗しました。')
      console.error('Error editing item:', error)
    }
  }

  async deleteItem(message, args) {
    try {
      if (args.length < 1) {
        return message.reply('使用方法: !deleteitem <id>')
      }

      const [id] = args
      const { error } = await this.supabase.from('items').delete().eq('id', id)

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('アイテム削除')
        .setDescription(`ID:${id}のアイテムを削除しました。`)
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('アイテムの削除に失敗しました。')
      console.error('Error deleting item:', error)
    }
  }

  // ユーティリティメソッド
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

  async handleShop(message) {
    try {
      const { data: items } = await this.supabase.from('items').select('*')

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

  async handleGetFBP(message, args) {
    try {
      if (args.length !== 1) {
        await message.reply('使用方法: !getfbp [@メンション または ユーザーID]')
        return
      }

      let targetUserId
      const mentionedUser = message.mentions.users.first()

      if (mentionedUser) {
        targetUserId = mentionedUser.id
      } else {
        targetUserId = args[0]
        if (!/^\d+$/.test(targetUserId)) {
          await message.reply('有効なユーザーIDまたはメンションを指定してください。')
          return
        }
      }

      const user = await this.getOrCreateUser(targetUserId)
      const { data: wallet } = await this.supabase.from('wallets').select('coins').eq('user_id', user.id).single()

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

  async handleInventory(message) {
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

  async handleAddFBP(message, args) {
    try {
      if (args.length !== 2) {
        await message.reply('使用方法: !addfbp [@メンション または ユーザーID] [金額]')
        return
      }

      let targetUserId
      const mentionedUser = message.mentions.users.first()

      if (mentionedUser) {
        targetUserId = mentionedUser.id
      } else {
        targetUserId = args[0]
        if (!/^\d+$/.test(targetUserId)) {
          await message.reply('有効なユーザーIDまたはメンションを指定してください。')
          return
        }
      }

      const amount = parseInt(args[1])
      if (isNaN(amount) || amount <= 0) {
        await message.reply('有効な金額を指定してください。')
        return
      }

      const user = await this.getOrCreateUser(targetUserId)
      await this.addFBP(user.id, amount, message.author.id)

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

  async listQuests(message) {
    try {
      const { data: quests, error } = await this.supabase
        .from('quests')
        .select('id, quest_number, fbp_reward, title')
        .order('quest_number')

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('クエスト一覧')
        .setDescription(
          quests.map((q) => `ID: ${q.id} | No.${q.quest_number} | ${q.fbp_reward}FBP | ${q.title}`).join('\n')
        )
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('クエスト一覧の取得に失敗しました。')
      console.error('Error listing quests:', error)
    }
  }

  async addQuest(message, args) {
    try {
      if (args.length < 3) {
        return message.reply('使用方法: !addquest <quest_number> <fbp_reward> <title>')
      }

      const [questNumber, fbpReward, ...titleParts] = args
      const title = titleParts.join(' ')

      const { error } = await this.supabase.from('quests').insert([
        {
          quest_number: questNumber.padStart(3, '0'),
          fbp_reward: parseInt(fbpReward),
          title
        }
      ])

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('クエスト追加')
        .setDescription(`クエスト${questNumber}を追加しました。`)
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('クエストの追加に失敗しました。')
      console.error('Error adding quest:', error)
    }
  }

  async editQuest(message, args) {
    try {
      if (args.length < 4) {
        return message.reply('使用方法: !editquest <id> <quest_number> <fbp_reward> <title>')
      }

      const [id, questNumber, fbpReward, ...titleParts] = args
      const title = titleParts.join(' ')

      const { error } = await this.supabase
        .from('quests')
        .update({
          quest_number: questNumber.padStart(3, '0'),
          fbp_reward: parseInt(fbpReward),
          title,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('クエスト編集')
        .setDescription(`ID:${id}のクエストを更新しました。`)
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('クエストの編集に失敗しました。')
      console.error('Error editing quest:', error)
    }
  }

  async deleteQuest(message, args) {
    try {
      if (args.length < 1) {
        return message.reply('使用方法: !deletequest <id>')
      }

      const [id] = args
      const { error } = await this.supabase.from('quests').delete().eq('id', id)

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('クエスト削除')
        .setDescription(`ID:${id}のクエストを削除しました。`)
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('クエストの削除に失敗しました。')
      console.error('Error deleting quest:', error)
    }
  }

  async listItems(message) {
    try {
      const { data: items, error } = await this.supabase.from('items').select('id, name, price').order('id')

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('アイテム一覧')
        .setDescription(items.map((i) => `ID: ${i.id} | ${i.name} | ${i.price}FBP`).join('\n'))
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('アイテム一覧の取得に失敗しました。')
      console.error('Error listing items:', error)
    }
  }

  async addItem(message, args) {
    try {
      if (args.length < 2) {
        return message.reply('使用方法: !additem <name> <price>')
      }

      const [price, ...nameParts] = args.reverse()
      const name = nameParts.reverse().join(' ')

      const { error } = await this.supabase.from('items').insert([
        {
          name,
          price: parseInt(price)
        }
      ])

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('アイテム追加')
        .setDescription(`${name}を追加しました。`)
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('アイテムの追加に失敗しました。')
      console.error('Error adding item:', error)
    }
  }

  async editItem(message, args) {
    try {
      if (args.length < 3) {
        return message.reply('使用方法: !edititem <id> <name> <price>')
      }

      const [id, price, ...nameParts] = args.reverse()
      const name = nameParts.reverse().join(' ')

      const { error } = await this.supabase
        .from('items')
        .update({
          name,
          price: parseInt(price),
          updated_at: new Date().toISOString()
        })
        .eq('id', id)

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('アイテム編集')
        .setDescription(`ID:${id}のアイテムを更新しました。`)
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('アイテムの編集に失敗しました。')
      console.error('Error editing item:', error)
    }
  }

  async deleteItem(message, args) {
    try {
      if (args.length < 1) {
        return message.reply('使用方法: !deleteitem <id>')
      }

      const [id] = args
      const { error } = await this.supabase.from('items').delete().eq('id', id)

      if (error) throw error

      const embed = new EmbedBuilder()
        .setTitle('アイテム削除')
        .setDescription(`ID:${id}のアイテムを削除しました。`)
        .setColor('#00ff00')

      await message.channel.send({ embeds: [embed] })
    } catch (error) {
      await message.channel.send('アイテムの削除に失敗しました。')
      console.error('Error deleting item:', error)
    }
  }
}

module.exports = CommandHandler
