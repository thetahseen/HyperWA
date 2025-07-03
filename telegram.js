const TelegramBot = require("node-telegram-bot-api")
const fs = require("fs")
const path = require("path")
const { execSync } = require("child_process")
const config = require("../config.js")
const { DatabaseOps } = require("./database.js")

let telegramBotInstance = null
let telegramBot = null
let topicMapping = {}
let reverseTopicMapping = {}
let statusTopicId = null
let callTopicId = null
let reactionSupported = null // Cache reaction support check
const contactsCache = {} // Cache for contact names
const pinnedMessages = {} // Track pinned messages for each topic
const statusMessageMapping = {} // Map Telegram message IDs to WhatsApp status message IDs
const chatMessageMapping = {} // Map Telegram message IDs to WhatsApp message IDs

// Check if ffmpeg is available
function checkFFmpegAvailable() {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" })
    return true
  } catch (error) {
    global.log?.warn("⚠️ FFmpeg not available - animated sticker conversion will be limited")
    return false
  }
}

const ffmpegAvailable = checkFFmpegAvailable()

// Convert animated WebP to MP4 for Telegram
async function convertAnimatedWebPToMP4(webpBuffer) {
  if (!ffmpegAvailable) {
    throw new Error("FFmpeg not available for animated sticker conversion")
  }

  const tempDir = path.join(__dirname, "..", "temp")
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }

  const inputFile = path.join(tempDir, `input_${Date.now()}.webp`)
  const outputFile = path.join(tempDir, `output_${Date.now()}.mp4`)

  try {
    fs.writeFileSync(inputFile, webpBuffer)
    execSync(
      `ffmpeg -i "${inputFile}" -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2" -c:v libx264 -pix_fmt yuv420p -t 3 -r 30 "${outputFile}"`,
      { stdio: "ignore" },
    )
    const mp4Buffer = fs.readFileSync(outputFile)
    fs.unlinkSync(inputFile)
    fs.unlinkSync(outputFile)
    return mp4Buffer
  } catch (error) {
    if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile)
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile)
    throw error
  }
}

// Convert Telegram animated sticker to WebP for WhatsApp
async function convertTelegramStickerToWebP(stickerBuffer, isAnimated = false) {
  if (!ffmpegAvailable && isAnimated) {
    throw new Error("FFmpeg not available for animated sticker conversion")
  }

  const tempDir = path.join(__dirname, "..", "temp")
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }

  const inputFile = path.join(tempDir, `input_${Date.now()}.${isAnimated ? "webm" : "webp"}`)
  const outputFile = path.join(tempDir, `output_${Date.now()}.webp`)

  try {
    // Write input file
    fs.writeFileSync(inputFile, stickerBuffer)

    if (isAnimated) {
      // Convert animated sticker using ffmpeg
      execSync(
        `ffmpeg -i "${inputFile}" -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2" -c:v libwebp -quality 80 -preset default -loop 0 -t 3 "${outputFile}"`,
        { stdio: "ignore" },
      )
    } else {
      // For static stickers, just ensure proper size
      execSync(
        `ffmpeg -i "${inputFile}" -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2" "${outputFile}"`,
        { stdio: "ignore" },
      )
    }

    // Read output file
    const webpBuffer = fs.readFileSync(outputFile)

    // Clean up
    fs.unlinkSync(inputFile)
    fs.unlinkSync(outputFile)

    return webpBuffer
  } catch (error) {
    // Clean up on error
    if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile)
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile)
    throw error
  }
}

// Convert video to video note format
async function convertToVideoNote(videoBuffer) {
  if (!ffmpegAvailable) {
    return videoBuffer // Return as-is if ffmpeg not available
  }

  const tempDir = path.join(__dirname, "..", "temp")
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }

  const inputFile = path.join(tempDir, `input_${Date.now()}.mp4`)
  const outputFile = path.join(tempDir, `output_${Date.now()}.mp4`)

  try {
    // Write input file
    fs.writeFileSync(inputFile, videoBuffer)

    // Convert to circular video note format
    execSync(
      `ffmpeg -i "${inputFile}" -vf "scale=240:240:force_original_aspect_ratio=increase,crop=240:240" -c:v libx264 -pix_fmt yuv420p -r 30 -t 60 "${outputFile}"`,
      { stdio: "ignore" },
    )

    // Read output file
    const videoNoteBuffer = fs.readFileSync(outputFile)

    // Clean up
    fs.unlinkSync(inputFile)
    fs.unlinkSync(outputFile)

    return videoNoteBuffer
  } catch (error) {
    // Clean up on error
    if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile)
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile)
    global.log?.warn("Failed to convert video note, sending as regular video:", error.message)
    return videoBuffer // Return original if conversion fails
  }
}

// Load existing topic mappings from database
async function loadTopicMappings() {
  try {
    const mappings = await DatabaseOps.getTelegramTopics()
    topicMapping = mappings.topicMapping || {}
    reverseTopicMapping = mappings.reverseTopicMapping || {}
    statusTopicId = mappings.statusTopicId || null
    callTopicId = mappings.callTopicId || null

    global.log?.info(`📋 Loaded ${Object.keys(topicMapping).length} topic mappings from database`)
    if (statusTopicId) global.log?.info(`📱 Status topic loaded: ${statusTopicId}`)
    if (callTopicId) global.log?.info(`📞 Call topic loaded: ${callTopicId}`)
  } catch (error) {
    global.log?.error("Error loading topic mappings:", error)
  }
}

// Custom reaction method using direct API call
async function setReaction(chatId, messageId, emoji) {
  try {
    const axios = require("axios")
    await axios.post(`https://api.telegram.org/bot${config.telegram.botToken}/setMessageReaction`, {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
    })
    return true
  } catch (err) {
    global.log?.debug("❌ Failed to set reaction:", err?.response?.data?.description || err.message)
    return false
  }
}

// Check if reactions are supported (always true now with custom method)
async function checkReactionSupport() {
  reactionSupported = true
  global.log?.info("✅ Using custom reaction method - reactions supported")
}

// Get contact name from WhatsApp contacts
async function getContactName(whatsappNumber, fallbackName) {
  try {
    if (contactsCache[whatsappNumber]) {
      return contactsCache[whatsappNumber]
    }

    const finalName = fallbackName || `Contact ${whatsappNumber}`
    contactsCache[whatsappNumber] = finalName
    return finalName
  } catch (error) {
    global.log?.debug("Error getting contact name:", error.message)
    return fallbackName || `Contact ${whatsappNumber}`
  }
}

// Get user info from WhatsApp
async function getUserInfo(whatsappNumber) {
  try {
    if (!global.bot) return null

    const jid = whatsappNumber + "@s.whatsapp.net"

    // Try to get user info
    const userInfo = {
      about: null,
      profilePicture: null,
      lastSeen: null,
    }

    try {
      // Get status/about
      const status = await global.bot.fetchStatus(jid).catch(() => null)
      if (status && status.status) {
        userInfo.about = status.status
      }
    } catch (error) {
      // Ignore errors
    }

    try {
      // Get profile picture URL
      const profilePic = await global.bot.profilePictureUrl(jid, "image").catch(() => null)
      if (profilePic) {
        userInfo.profilePicture = profilePic
      }
    } catch (error) {
      // Ignore errors
    }

    return userInfo
  } catch (error) {
    global.log?.debug("Error getting user info:", error.message)
    return null
  }
}

// Create and pin user info message
async function createAndPinUserInfo(topicId, contactName, whatsappNumber) {
  try {
    // Skip if already pinned
    if (pinnedMessages[topicId]) {
      return
    }

    // Get additional user info
    const userInfo = await getUserInfo(whatsappNumber)

    let userInfoText = `👤 *Contact Information*\n\n`
    userInfoText += `📝 *Name:* ${contactName}\n`
    userInfoText += `📞 *WhatsApp:* +${whatsappNumber}\n`

    if (userInfo && userInfo.about) {
      userInfoText += `💬 *About:* ${userInfo.about}\n`
    }

    userInfoText += `\n🔄 *Reply to this topic to send messages to WhatsApp*`

    const infoMessage = await telegramBot.sendMessage(config.telegram.groupId, userInfoText, {
      parse_mode: "Markdown",
      message_thread_id: topicId,
      disable_web_page_preview: true,
    })

    // Pin the message with better error handling
    if (infoMessage && infoMessage.message_id) {
      try {
        await telegramBot.pinChatMessage(config.telegram.groupId, infoMessage.message_id, {
          disable_notification: true,
        })
        pinnedMessages[topicId] = infoMessage.message_id
        global.log?.info(`📌 Pinned user info for topic ${topicId}`)
      } catch (pinError) {
        global.log?.warn(`Could not pin message: ${pinError.message}`)
        // Try alternative pinning method
        try {
          await telegramBot.pinChatMessage(config.telegram.groupId, infoMessage.message_id)
          pinnedMessages[topicId] = infoMessage.message_id
          global.log?.info(`📌 Pinned user info for topic ${topicId} (alternative method)`)
        } catch (altPinError) {
          global.log?.error(`Failed to pin message with alternative method: ${altPinError.message}`)
        }
      }
    }
  } catch (error) {
    global.log?.error("Error creating user info:", error.message)
  }
}

// Create and pin group info message
async function createAndPinGroupInfo(topicId, groupName, groupIdentifier) {
  try {
    if (pinnedMessages[topicId]) {
      return
    }

    let groupInfoText = `🏷️ *Group Information*\n\n`
    groupInfoText += `📝 *Name:* ${groupName.replace("🏷️ ", "")}\n`
    groupInfoText += `🆔 *Group ID:* ${groupIdentifier.replace("group_", "")}\n`
    groupInfoText += `\n🔄 *Reply to this topic to send messages to the WhatsApp group*`
    groupInfoText += `\n👥 *All group members will see your message*`
    groupInfoText += `\n💬 *Reply to a message to quote it on WhatsApp*`

    const infoMessage = await telegramBot.sendMessage(config.telegram.groupId, groupInfoText, {
      parse_mode: "Markdown",
      message_thread_id: topicId,
      disable_web_page_preview: true,
    })

    if (infoMessage && infoMessage.message_id) {
      try {
        await telegramBot.pinChatMessage(config.telegram.groupId, infoMessage.message_id, {
          disable_notification: true,
        })
        pinnedMessages[topicId] = infoMessage.message_id
        global.log?.info(`📌 Pinned group info for topic ${topicId}`)
      } catch (pinError) {
        global.log?.warn(`Could not pin group message: ${pinError.message}`)
      }
    }
  } catch (error) {
    global.log?.error("Error creating group info:", error.message)
  }
}

// Create status topic
async function createStatusTopic() {
  if (!config.telegram.createTopics || !telegramBot) {
    return null
  }

  try {
    global.log?.info("Creating Status Updates topic...")

    const result = await telegramBot.createForumTopic(config.telegram.groupId, "📱 Status Updates", {
      icon_color: 0x00ff00, // Green color for status
    })

    if (result && result.message_thread_id) {
      statusTopicId = result.message_thread_id

      // Save to database
      await DatabaseOps.saveSpecialTopic("status", statusTopicId)

      // Create info message for status topic
      const statusInfoText = `📱 *WhatsApp Status Updates*\n\n🔄 This topic shows all WhatsApp status updates\n📊 Status views, images, videos will appear here\n💬 Reply to a status to react to it on WhatsApp\n⚠️ Only statuses with captions or media are forwarded`

      await telegramBot.sendMessage(config.telegram.groupId, statusInfoText, {
        parse_mode: "Markdown",
        message_thread_id: statusTopicId,
        disable_web_page_preview: true,
      })

      global.log?.info(`✅ Created Status topic: ${statusTopicId}`)
      return statusTopicId
    }
  } catch (error) {
    global.log?.error("❌ Error creating status topic:", error.message)
  }

  return null
}

// Create call topic
async function createCallTopic() {
  if (!config.telegram.createTopics || !telegramBot) {
    return null
  }

  try {
    global.log?.info("Creating Call Logs topic...")

    const result = await telegramBot.createForumTopic(config.telegram.groupId, "📞 Call Logs", {
      icon_color: 0xff0000, // Red color for calls
    })

    if (result && result.message_thread_id) {
      callTopicId = result.message_thread_id

      // Save to database
      await DatabaseOps.saveSpecialTopic("call", callTopicId)

      // Create info message for call topic
      const callInfoText = `📞 *WhatsApp Call Logs*\n\n📋 All incoming and outgoing calls will be logged here\n📱 Voice and video calls included\n⚠️ This is a read-only topic`

      await telegramBot.sendMessage(config.telegram.groupId, callInfoText, {
        parse_mode: "Markdown",
        message_thread_id: callTopicId,
        disable_web_page_preview: true,
      })

      global.log?.info(`✅ Created Call topic: ${callTopicId}`)
      return callTopicId
    }
  } catch (error) {
    global.log?.error("❌ Error creating call topic:", error.message)
  }

  return null
}

// Check if user is authorized
function isAuthorizedUser(userId) {
  return config.telegram.adminIds.includes(userId)
}

// Send message to Telegram with topic recreation logic
async function sendToTelegramWithRetry(chatId, message, options, identifier = null, displayName = null) {
  try {
    return await telegramBot.sendMessage(chatId, message, options)
  } catch (error) {
    global.log?.warn(`Failed to send message to topic ${options.message_thread_id}: ${error.message}`)

    // If it's a topic-related error and we have identifier info, recreate the topic
    if (
      identifier &&
      displayName &&
      options.message_thread_id &&
      (error.message.includes("thread") || error.message.includes("topic") || error.message.includes("not found"))
    ) {
      global.log?.info(`Recreating topic for ${identifier}...`)

      // Remove old mapping
      delete topicMapping[identifier]
      delete reverseTopicMapping[options.message_thread_id]

      // Create new topic
      const newTopicId = await getOrCreateTopic(identifier, displayName)

      if (newTopicId) {
        // Update options with new topic ID
        options.message_thread_id = newTopicId

        // Retry sending the message
        try {
          return await telegramBot.sendMessage(chatId, message, options)
        } catch (retryError) {
          global.log?.error(`Failed to send message even after topic recreation: ${retryError.message}`)
          throw retryError
        }
      }
    }

    throw error
  }
}

// Initialize Telegram bot
function initTelegramBot() {
  if (!config.telegram.enabled || !config.telegram.botToken) {
    return null
  }

  // Return existing instance if already created
  if (telegramBotInstance) {
    global.log?.info("📱 Using existing Telegram bot instance")
    return telegramBotInstance
  }

  try {
    telegramBotInstance = new TelegramBot(config.telegram.botToken, { polling: true })
    telegramBot = telegramBotInstance

    // Load topic mappings from database
    loadTopicMappings()

    // Check reaction support
    checkReactionSupport()

    // Handle all messages (including commands)
    telegramBot.on("message", async (msg) => {
      try {
        global.log?.info(
          `📨 Telegram message received: ${msg.text || "media"} from ${msg.from.username || msg.from.first_name} (${msg.from.id}) in chat ${msg.chat.id}`,
        )

        // Handle commands first
        if (msg.text && msg.text.startsWith("/")) {
          await handleTelegramCommand(msg)
          return
        }

        // Then handle regular messages
        await handleTelegramMessage(msg)
      } catch (error) {
        global.log?.error("Error processing Telegram message:", error)
      }
    })

    // Handle errors
    telegramBot.on("error", (error) => {
      global.log?.error("Telegram bot error:", error)
    })

    // Handle polling errors
    telegramBot.on("polling_error", (error) => {
      global.log?.error("Telegram polling error:", error)
    })

    global.log?.info("✅ Telegram bot initialized successfully")
    if (ffmpegAvailable) {
      global.log?.info("🎬 FFmpeg available - full media conversion support enabled")
    }
    return telegramBot
  } catch (error) {
    global.log?.error("Failed to initialize Telegram bot:", error)
    return null
  }
}

// Handle Telegram commands
async function handleTelegramCommand(msg) {
  const command = msg.text.split(" ")[0].toLowerCase()
  const chatId = msg.chat.id
  const userId = msg.from.id

  global.log?.info(`🔧 Processing command: ${command} from user ${userId} in chat ${chatId}`)

  try {
    switch (command) {
      case "/start":
        if (chatId.toString() === config.telegram.groupId.toString()) {
          // Command in the group
          await telegramBot.sendMessage(
            chatId,
            `🤖 *Open WABOT Telegram Bridge*\n\n✅ Bot is active and ready!\n\n📱 WhatsApp messages will be forwarded here\n🔄 Reply in topics to send back to WhatsApp\n✅ Clean message forwarding\n\n📊 Special Topics:\n• 📱 Status Updates\n• 📞 Call Logs\n\n💡 Use /status to check bridge status\n💡 Use /help for more commands`,
            { parse_mode: "Markdown" },
          )
        } else {
          // Command in private chat
          if (isAuthorizedUser(userId)) {
            await telegramBot.sendMessage(
              chatId,
              `👋 Hello! I'm the Open WABOT Telegram Bridge.\n\n🔧 *Admin Commands:*\n/status - Check bridge status\n/help - Show this help\n/info - Bot information\n/cleantopics - Remove deleted topics from database\n\n📱 *Group:* ${config.telegram.groupId}\n✅ You are authorized to use admin commands.`,
              { parse_mode: "Markdown" },
            )
          } else {
            await telegramBot.sendMessage(
              chatId,
              `👋 Hello! I'm the Open WABOT Telegram Bridge.\n\n❌ You are not authorized to use this bot.\n📱 Please contact an administrator for access.\n\n🔧 *Authorized Users:* ${config.telegram.adminIds.join(", ")}`,
            )
          }
        }
        break

      case "/status":
        if (isAuthorizedUser(userId) || chatId.toString() === config.telegram.groupId.toString()) {
          const stats = await DatabaseOps.getStats()
          const botInfo = await telegramBot.getMe()

          let statusText = `📊 *Bridge Status*\n\n`
          statusText += `🤖 Bot: @${botInfo.username}\n`
          statusText += `📱 Group: ${config.telegram.groupId}\n`
          statusText += `📝 Contact Topics: ${Object.keys(topicMapping).length}\n`
          statusText += `📊 Status Topic: ${statusTopicId ? "✅" : "❌"}\n`
          statusText += `📞 Call Topic: ${callTopicId ? "✅" : "❌"}\n`
          statusText += `🗄️ Database: ${stats ? stats.type : "Disconnected"}\n`
          statusText += `👍 Reactions: ${reactionSupported ? "✅ Supported" : "⚠️ Fallback"}\n`
          statusText += `🎬 FFmpeg: ${ffmpegAvailable ? "✅ Available" : "❌ Not Available"}\n`

          if (stats && stats.collections) {
            statusText += `👥 Users: ${stats.collections.users || 0}\n`
            statusText += `💬 Messages: ${stats.collections.messages || 0}\n`
          }

          statusText += `\n⏰ Last updated: ${new Date().toLocaleString()}`

          await telegramBot.sendMessage(chatId, statusText, { parse_mode: "Markdown" })
        } else {
          await telegramBot.sendMessage(chatId, "❌ You are not authorized to use this command.")
        }
        break

      case "/cleantopics":
        if (isAuthorizedUser(userId)) {
          await cleanDeletedTopics()
          await telegramBot.sendMessage(chatId, "🧹 Cleaned deleted topics from database.")
        } else {
          await telegramBot.sendMessage(chatId, "❌ You are not authorized to use this command.")
        }
        break

      case "/help":
        if (isAuthorizedUser(userId) || chatId.toString() === config.telegram.groupId.toString()) {
          const helpText = `🔧 *Available Commands:*\n\n/start - Initialize bot\n/status - Check bridge status\n/help - Show this help\n/info - Bot information\n/ping - Test bot response\n/cleantopics - Clean deleted topics (admin only)\n\n📱 *How to use:*\n• Messages from WhatsApp appear in topics\n• Reply in topics to send back to WhatsApp\n• Status updates and calls have separate topics\n• Reply to status messages to react on WhatsApp\n• If you delete a topic, it will be recreated automatically\n\n👥 *Authorized Users:* ${config.telegram.adminIds.join(", ")}`

          await telegramBot.sendMessage(chatId, helpText, { parse_mode: "Markdown" })
        } else {
          await telegramBot.sendMessage(chatId, "❌ You are not authorized to use this command.")
        }
        break

      case "/info":
        if (isAuthorizedUser(userId) || chatId.toString() === config.telegram.groupId.toString()) {
          const botInfo = await telegramBot.getMe()
          const infoText = `🤖 *Bot Information*\n\n📝 Name: ${botInfo.first_name}\n🔗 Username: @${botInfo.username}\n🆔 ID: ${botInfo.id}\n\n📱 *Configuration:*\n• Group ID: ${config.telegram.groupId}\n• Create Topics: ${config.telegram.createTopics ? "✅" : "❌"}\n• Forward Media: ${config.telegram.forwardMedia ? "✅" : "❌"}\n• Admin IDs: ${config.telegram.adminIds.join(", ")}\n• FFmpeg: ${ffmpegAvailable ? "✅ Available" : "❌ Not Available"}\n\n⚡ Status: Online`

          await telegramBot.sendMessage(chatId, infoText, { parse_mode: "Markdown" })
        } else {
          await telegramBot.sendMessage(chatId, "❌ You are not authorized to use this command.")
        }
        break

      case "/ping":
        await telegramBot.sendMessage(chatId, `🏓 Pong! Bot is online.\n⏰ ${new Date().toLocaleString()}`)
        break

      default:
        if (isAuthorizedUser(userId) || chatId.toString() === config.telegram.groupId.toString()) {
          await telegramBot.sendMessage(
            chatId,
            `❓ Unknown command: ${command}\n\nUse /help to see available commands.`,
          )
        }
        break
    }

    global.log?.info(`✅ Command ${command} processed successfully`)
  } catch (error) {
    global.log?.error(`❌ Error processing command ${command}:`, error)
    await telegramBot.sendMessage(chatId, `❌ Error processing command: ${error.message}`)
  }
}

// Clean deleted topics from database - simplified approach
async function cleanDeletedTopics() {
  try {
    global.log?.info("🧹 Cleaned deleted topics command executed - topics will be recreated as needed")
  } catch (error) {
    global.log?.error("Error cleaning deleted topics:", error)
  }
}

// Send confirmation (reaction or message based on config)
async function sendConfirmation(msg, contact, success = true) {
  // Try custom reaction method first
  try {
    const emoji = success ? "✅" : "❌"
    const reactionSuccess = await setReaction(msg.chat.id, msg.message_id, emoji)

    if (reactionSuccess) {
      global.log?.debug(`${emoji} Custom reaction added successfully`)
      return
    }
  } catch (reactionError) {
    global.log?.warn("❌ Failed to add custom reaction:", reactionError.message)
  }

  // Send confirmation message if reactions failed or config enabled
  if (config.telegram.sendConfirmation) {
    try {
      const confirmationText = success ? "✅ Message sent to WhatsApp" : "❌ Failed to send message to WhatsApp"

      await telegramBot.sendMessage(msg.chat.id, confirmationText, {
        message_thread_id: msg.message_thread_id,
        reply_to_message_id: msg.message_id,
      })
      global.log?.debug("✅ Confirmation message sent")
    } catch (messageError) {
      global.log?.warn("❌ Failed to send confirmation message:", messageError.message)
    }
  }
}

// Handle incoming Telegram messages (non-commands) - with topic recreation logic
async function handleTelegramMessage(msg) {
  try {
    // Only process messages from the configured group
    if (msg.chat.id.toString() !== config.telegram.groupId.toString()) {
      return
    }

    // Skip bot messages
    if (msg.from.is_bot) {
      return
    }

    // Only process messages in topics
    if (!msg.message_thread_id) {
      return
    }

    const topicId = msg.message_thread_id

    // Handle replies in status topic
    if (topicId === statusTopicId) {
      if (msg.reply_to_message && statusMessageMapping[msg.reply_to_message.message_id]) {
        const statusInfo = statusMessageMapping[msg.reply_to_message.message_id]
        const [statusSender, statusTimestamp] = statusInfo.split("_")
        const replyText = msg.text || msg.caption || "👍"

        try {
          // Send reaction to WhatsApp status
          if (global.bot && global.bot.sendMessage) {
            const statusJid = statusSender + "@s.whatsapp.net"

            // Create a proper reaction message
            const reactionMessage = {
              react: {
                text: replyText.charAt(0), // Use first character as reaction emoji
                key: {
                  remoteJid: statusJid,
                  fromMe: false,
                  id: `status_${statusTimestamp}`, // Use timestamp as message ID
                },
              },
            }

            await global.bot.sendMessage(statusJid, reactionMessage)

            // Use custom reaction method for confirmation
            await setReaction(msg.chat.id, msg.message_id, "✅")
            global.log?.info(`✅ Status reaction sent to WhatsApp: ${replyText.charAt(0)} to ${statusSender}`)
          }
        } catch (error) {
          global.log?.error("Failed to send status reaction:", error.message)
          await setReaction(msg.chat.id, msg.message_id, "❌")
        }
      } else {
        // If not replying to a status, send info message
        await telegramBot.sendMessage(msg.chat.id, "💡 Reply to a status message to react to it on WhatsApp", {
          message_thread_id: topicId,
          reply_to_message_id: msg.message_id,
        })
      }
      return // Don't process status topic messages further
    }

    // Skip call topics - they are one-way only
    if (topicId === callTopicId) {
      return
    }

    const identifier = reverseTopicMapping[topicId]

    if (!identifier) {
      global.log?.warn(`No identifier found for topic ID: ${topicId}`)
      return
    }

    let whatsappJid

    // Determine if this is a group or individual chat
    if (identifier.startsWith("group_")) {
      // This is a group chat
      const groupId = identifier.replace("group_", "")
      whatsappJid = groupId + "@g.us"
      global.log?.info(`Sending message to WhatsApp group: ${groupId}`)
    } else {
      // This is an individual chat
      whatsappJid = identifier + "@s.whatsapp.net"
      global.log?.info(`Sending message to WhatsApp contact: ${identifier}`)
    }

    // Handle replies in chat topics
    let quotedMessage = null
    if (msg.reply_to_message && chatMessageMapping[msg.reply_to_message.message_id]) {
      const originalMessageId = chatMessageMapping[msg.reply_to_message.message_id]
      quotedMessage = {
        key: { id: originalMessageId },
        message: { conversation: msg.reply_to_message.text || "Media message" },
      }
      global.log?.info(`Replying to WhatsApp message: ${originalMessageId}`)
    }

    // Handle contact messages
    if (msg.contact) {
      try {
        const contactMessage = {
          contacts: {
            displayName: msg.contact.first_name + (msg.contact.last_name ? ` ${msg.contact.last_name}` : ""),
            contacts: [
              {
                displayName: msg.contact.first_name + (msg.contact.last_name ? ` ${msg.contact.last_name}` : ""),
                vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${msg.contact.first_name}${msg.contact.last_name ? ` ${msg.contact.last_name}` : ""}\nTEL:${msg.contact.phone_number}\nEND:VCARD`,
              },
            ],
          },
        }

        if (quotedMessage) {
          contactMessage.quoted = quotedMessage
        }

        await global.bot.sendMessage(whatsappJid, contactMessage)
        await sendConfirmation(msg, { whatsapp_id: whatsappJid }, true)
        global.log?.info(`✅ Contact sent to WhatsApp: ${whatsappJid}`)
        return
      } catch (error) {
        global.log?.error(`❌ Failed to send contact to WhatsApp: ${error.message}`)
        await sendConfirmation(msg, { whatsapp_id: whatsappJid }, false)
        return
      }
    }

    // Handle location messages
    if (msg.location) {
      try {
        const locationMessage = {
          location: {
            degreesLatitude: msg.location.latitude,
            degreesLongitude: msg.location.longitude,
          },
        }

        if (quotedMessage) {
          locationMessage.quoted = quotedMessage
        }

        await global.bot.sendMessage(whatsappJid, locationMessage)
        await sendConfirmation(msg, { whatsapp_id: whatsappJid }, true)
        global.log?.info(`✅ Location sent to WhatsApp: ${whatsappJid}`)
        return
      } catch (error) {
        global.log?.error(`❌ Failed to send location to WhatsApp: ${error.message}`)
        await sendConfirmation(msg, { whatsapp_id: whatsappJid }, false)
        return
      }
    }

    // Handle media messages from Telegram to WhatsApp
    if (
      msg.photo ||
      msg.video ||
      msg.audio ||
      msg.voice ||
      msg.video_note ||
      msg.animation ||
      msg.document ||
      msg.sticker
    ) {
      let mediaBuffer = null
      let fileName = null

      try {
        if (msg.photo) {
          const photo = msg.photo[msg.photo.length - 1]
          const fileLink = await telegramBot.getFileLink(photo.file_id)
          const response = await require("axios").get(fileLink, { responseType: "arraybuffer" })
          mediaBuffer = Buffer.from(response.data)
        } else if (msg.video) {
          const fileLink = await telegramBot.getFileLink(msg.video.file_id)
          const response = await require("axios").get(fileLink, { responseType: "arraybuffer" })
          mediaBuffer = Buffer.from(response.data)
        } else if (msg.video_note) {
          const fileLink = await telegramBot.getFileLink(msg.video_note.file_id)
          const response = await require("axios").get(fileLink, { responseType: "arraybuffer" })
          mediaBuffer = Buffer.from(response.data)
        } else if (msg.animation) {
          const fileLink = await telegramBot.getFileLink(msg.animation.file_id)
          const response = await require("axios").get(fileLink, { responseType: "arraybuffer" })
          mediaBuffer = Buffer.from(response.data)
        } else if (msg.audio) {
          const fileLink = await telegramBot.getFileLink(msg.audio.file_id)
          const response = await require("axios").get(fileLink, { responseType: "arraybuffer" })
          mediaBuffer = Buffer.from(response.data)
        } else if (msg.voice) {
          const fileLink = await telegramBot.getFileLink(msg.voice.file_id)
          const response = await require("axios").get(fileLink, { responseType: "arraybuffer" })
          mediaBuffer = Buffer.from(response.data)
        } else if (msg.document) {
          const fileLink = await telegramBot.getFileLink(msg.document.file_id)
          const response = await require("axios").get(fileLink, { responseType: "arraybuffer" })
          mediaBuffer = Buffer.from(response.data)
          fileName = msg.document.file_name
        } else if (msg.sticker) {
          const fileLink = await telegramBot.getFileLink(msg.sticker.file_id)
          const response = await require("axios").get(fileLink, { responseType: "arraybuffer" })
          mediaBuffer = Buffer.from(response.data)
        }

        if (mediaBuffer && global.bot && global.bot.sendMessage) {
          try {
            const mediaMessage = {
              caption: msg.caption || msg.text || "",
            }

            // Add quoted message if replying
            if (quotedMessage) {
              mediaMessage.quoted = quotedMessage
            }

            // Determine media type and set appropriate field
            if (msg.photo) {
              mediaMessage.image = mediaBuffer
            } else if (msg.video) {
              mediaMessage.video = mediaBuffer
            } else if (msg.video_note) {
              mediaMessage.video = mediaBuffer
              mediaMessage.ptv = true
            } else if (msg.animation) {
              mediaMessage.video = mediaBuffer
              mediaMessage.gifPlayback = true
            } else if (msg.audio || msg.voice) {
              mediaMessage.audio = mediaBuffer
              mediaMessage.mimetype = "audio/ogg; codecs=opus"
              if (msg.voice) {
                mediaMessage.ptt = true
              }
            } else if (msg.sticker) {
              try {
                if (msg.sticker.is_animated) {
                  const convertedBuffer = await convertTelegramStickerToWebP(mediaBuffer, true)
                  mediaMessage.sticker = convertedBuffer
                } else {
                  const convertedBuffer = await convertTelegramStickerToWebP(mediaBuffer, false)
                  mediaMessage.sticker = convertedBuffer
                }
              } catch (conversionError) {
                global.log?.warn("Failed to convert Telegram sticker:", conversionError.message)
                mediaMessage.image = mediaBuffer
                delete mediaMessage.sticker
              }
            } else {
              mediaMessage.document = mediaBuffer
              if (fileName) {
                mediaMessage.fileName = fileName
              }
            }

            await global.bot.sendMessage(whatsappJid, mediaMessage)
            await sendConfirmation(msg, { whatsapp_id: whatsappJid }, true)
            global.log?.info(`✅ Media sent to WhatsApp: ${whatsappJid}`)
            return
          } catch (error) {
            global.log?.error(`❌ Failed to send media to WhatsApp: ${error.message}`)
            await sendConfirmation(msg, { whatsapp_id: whatsappJid }, false)
            return
          }
        }
      } catch (error) {
        global.log?.error("Error processing media from Telegram:", error.message)
        await sendConfirmation(msg, { whatsapp_id: whatsappJid }, false)
        return
      }
    }

    // Handle text messages
    let messageText = msg.text || msg.caption || ""

    if (!messageText) {
      messageText = "📱 Message from Telegram"
    }

    // Send reply back to WhatsApp
    if (global.bot && global.bot.sendMessage) {
      try {
        const textMessage = { text: messageText }

        // Add quoted message if replying
        if (quotedMessage) {
          textMessage.quoted = quotedMessage
        }

        await global.bot.sendMessage(whatsappJid, textMessage)
        await sendConfirmation(msg, { whatsapp_id: whatsappJid }, true)
        global.log?.info(`✅ Message sent to WhatsApp: ${whatsappJid}`)
      } catch (error) {
        global.log?.error(`❌ Failed to send message to WhatsApp: ${error.message}`)
        await sendConfirmation(msg, { whatsapp_id: whatsappJid }, false)
      }
    } else {
      await sendConfirmation(msg, { whatsapp_id: whatsappJid }, false)
    }
  } catch (error) {
    global.log?.error("Error handling Telegram message:", error)
  }
}

// Create or get topic for a WhatsApp contact - with recreation logic
async function getOrCreateTopic(identifier, displayName) {
  if (!config.telegram.createTopics || !telegramBot) {
    return null
  }

  // Check if topic already exists
  if (topicMapping[identifier]) {
    return topicMapping[identifier]
  }

  try {
    let topicName
    if (identifier.startsWith("group_")) {
      topicName = displayName
    } else {
      const cleanContactName = await getContactName(identifier, displayName)
      topicName = `${cleanContactName} (+${identifier})`
    }

    global.log?.info(`Creating Telegram topic: ${topicName}`)

    const result = await telegramBot.createForumTopic(config.telegram.groupId, topicName, {
      icon_color: identifier.startsWith("group_") ? 0x00ff00 : 0x6fb9f0,
    })

    if (result && result.message_thread_id) {
      topicMapping[identifier] = result.message_thread_id
      reverseTopicMapping[result.message_thread_id] = identifier

      await DatabaseOps.saveTelegramTopic(identifier, result.message_thread_id, displayName)

      // Create and pin info message after topic creation
      if (identifier.startsWith("group_")) {
        await createAndPinGroupInfo(result.message_thread_id, displayName, identifier)
      } else {
        await createAndPinUserInfo(result.message_thread_id, displayName, identifier)
      }

      global.log?.info(`✅ Created Telegram topic for ${displayName}: ${result.message_thread_id}`)
      return result.message_thread_id
    }
  } catch (error) {
    global.log?.error(`❌ Error creating topic for ${displayName}:`, error.message)

    // If topic creation failed due to duplicate name, try with a timestamp
    if (error.message.includes("duplicate") || error.message.includes("already exists")) {
      try {
        const timestamp = Date.now().toString().slice(-4)
        let topicName
        if (identifier.startsWith("group_")) {
          topicName = `${displayName} (${timestamp})`
        } else {
          const cleanContactName = await getContactName(identifier, displayName)
          topicName = `${cleanContactName} (+${identifier}) ${timestamp}`
        }

        global.log?.info(`Retrying with unique name: ${topicName}`)

        const result = await telegramBot.createForumTopic(config.telegram.groupId, topicName, {
          icon_color: identifier.startsWith("group_") ? 0x00ff00 : 0x6fb9f0,
        })

        if (result && result.message_thread_id) {
          topicMapping[identifier] = result.message_thread_id
          reverseTopicMapping[result.message_thread_id] = identifier
          await DatabaseOps.saveTelegramTopic(identifier, result.message_thread_id, displayName)

          global.log?.info(`✅ Created Telegram topic with unique name: ${result.message_thread_id}`)
          return result.message_thread_id
        }
      } catch (retryError) {
        global.log?.error(`❌ Retry failed for ${displayName}:`, retryError.message)
      }
    }
  }

  return null
}

// Forward call log to Telegram
async function forwardCallToTelegram(callData) {
  if (!config.telegram.enabled || !telegramBot || !config.telegram.groupId) {
    return
  }

  try {
    // Get or create call topic
    if (!callTopicId) {
      await createCallTopic()
    }

    if (!callTopicId) {
      global.log?.error("Failed to get or create call topic")
      return
    }

    let callText = `📞 **${callData.isVideo ? "Video" : "Voice"} Call**\n\n`
    callText += `👤 *From:* ${callData.name || callData.number} (+${callData.number})\n`
    callText += `⏰ *Time:* ${callData.timestamp.toLocaleString()}\n`
    callText += `🔄 *Status:* ${callData.status || "Incoming"}\n`

    if (callData.callType === "group") {
      callText += `👥 *Type:* Group Call\n`
    }

    if (callData.duration) {
      callText += `⏱️ *Duration:* ${callData.duration} seconds\n`
    }

    if (callData.status === "offer") {
      callText += `\n🔴 *Incoming call ${config.antiCall ? "(Auto-rejected)" : ""}*`
    } else if (callData.status === "accept") {
      callText += `\n🟢 *Call answered*`
    } else if (callData.status === "reject") {
      callText += `\n🔴 *Call rejected*`
    } else if (callData.status === "timeout") {
      callText += `\n⏰ *Call timed out*`
    }

    const sendOptions = {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      message_thread_id: callTopicId,
    }

    await telegramBot.sendMessage(config.telegram.groupId, callText, sendOptions)

    global.log?.info(
      `✅ Call log forwarded to Telegram: ${callData.isVideo ? "Video" : "Voice"} call from ${callData.name}`,
    )
  } catch (error) {
    global.log?.error("Error forwarding call to Telegram:", error.message)
  }
}

// Forward status update to Telegram
async function forwardStatusToTelegram(statusData) {
  if (!config.telegram.enabled || !telegramBot || !config.telegram.groupId) {
    return
  }

  try {
    // Get or create status topic
    if (!statusTopicId) {
      await createStatusTopic()
    }

    if (!statusTopicId) {
      global.log?.error("Failed to get or create status topic")
      return
    }

    // Only forward status if it has caption or media
    if (!statusData.caption && !statusData.media) {
      global.log?.info(`Skipping status without caption or media from ${statusData.name}`)
      return
    }

    // Create a unique status ID for mapping
    const statusId = `${statusData.number}_${Date.now()}`

    // Forward media with caption including name
    if (statusData.media && config.telegram.forwardMedia) {
      try {
        let caption = `📱 *${statusData.name || statusData.number}*`

        if (statusData.caption && statusData.caption.trim()) {
          caption += `\n\n${statusData.caption}`
        }

        const mediaOptions = {
          message_thread_id: statusTopicId,
          caption: caption,
          parse_mode: "Markdown",
        }

        let sentMessage = null

        if (statusData.type === "imageMessage" || statusData.type === "image") {
          sentMessage = await telegramBot.sendPhoto(config.telegram.groupId, statusData.media, mediaOptions)
        } else if (statusData.type === "videoMessage" || statusData.type === "video") {
          sentMessage = await telegramBot.sendVideo(config.telegram.groupId, statusData.media, mediaOptions)
        } else {
          mediaOptions.filename = `status_${Date.now()}.${statusData.type || "bin"}`
          sentMessage = await telegramBot.sendDocument(config.telegram.groupId, statusData.media, mediaOptions)
        }

        // Map Telegram message to WhatsApp status for replies
        if (sentMessage && sentMessage.message_id) {
          statusMessageMapping[sentMessage.message_id] = statusId
          global.log?.info(`📱 Status mapped: Telegram ${sentMessage.message_id} -> WhatsApp ${statusId}`)
        }

        global.log?.info(`✅ Status media forwarded to Telegram from ${statusData.name}`)
      } catch (mediaError) {
        global.log?.error("Error forwarding status media:", mediaError.message)
      }
    } else if (statusData.caption && statusData.caption.trim()) {
      // Forward text-only status with name
      try {
        const statusText = `📱 *${statusData.name || statusData.number}*\n\n${statusData.caption}`

        const sendOptions = {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
          message_thread_id: statusTopicId,
        }

        const sentMessage = await telegramBot.sendMessage(config.telegram.groupId, statusText, sendOptions)

        // Map Telegram message to WhatsApp status for replies
        if (sentMessage && sentMessage.message_id) {
          statusMessageMapping[sentMessage.message_id] = statusId
          global.log?.info(`📱 Status mapped: Telegram ${sentMessage.message_id} -> WhatsApp ${statusId}`)
        }

        global.log?.info(`✅ Status text forwarded to Telegram from ${statusData.name}`)
      } catch (textError) {
        global.log?.error("Error forwarding status text:", textError.message)
      }
    }
  } catch (error) {
    global.log?.error("Error forwarding status to Telegram:", error.message)
  }
}

// Forward WhatsApp message to Telegram
async function forwardToTelegram(m) {
  if (!config.telegram.enabled || !telegramBot || !config.telegram.groupId) {
    return
  }

  try {
    let identifier, displayName, topicId

    // Handle GROUP messages differently
    if (m.isGroup) {
      const groupId = m.chat.replace("@g.us", "")
      const groupName = m.group?.subject || `Group ${groupId.substring(0, 8)}`

      identifier = `group_${groupId}`
      displayName = `🏷️ ${groupName}`

      global.log?.info(`Processing GROUP message from: ${m.name} in ${groupName}`)

      topicId = await getOrCreateTopic(identifier, displayName)

      // Prepare message with sender info for group messages
      let messageText = ""

      if (m.body && m.body.trim()) {
        messageText = `👤 **${m.name}**: ${m.body}`
      } else if (m.mimetype && !m.mimetype.startsWith("text/")) {
        messageText = `👤 **${m.name}**: _sent media_`
      } else {
        messageText = `👤 **${m.name}**: _sent a message_`
      }

      // Send the message for groups (always send text to show who sent it)
      if (messageText) {
        const sendOptions = {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
          message_thread_id: topicId,
        }

        try {
          const sentMessage = await sendToTelegramWithRetry(
            config.telegram.groupId,
            messageText,
            sendOptions,
            identifier,
            displayName,
          )

          // Map Telegram message to WhatsApp message for replies
          if (sentMessage && sentMessage.message_id && m.id) {
            chatMessageMapping[sentMessage.message_id] = m.id
          }

          global.log?.info(`✅ Group message text sent to Telegram`)
        } catch (sendError) {
          global.log?.error("Error sending group message text:", sendError.message)
        }
      }
    } else {
      // Handle INDIVIDUAL messages
      let whatsappNumber = m.sender.user || m.sender.split("@")[0]
      whatsappNumber = whatsappNumber.replace(/[^\d+]/g, "")

      if (whatsappNumber.startsWith("+")) {
        whatsappNumber = whatsappNumber.substring(1)
      }

      let contactName = m.name || `Contact ${whatsappNumber}`

      if (contactName === "undefined" || !contactName || contactName.trim() === "") {
        contactName = `Contact ${whatsappNumber}`
      }

      identifier = whatsappNumber
      displayName = contactName

      global.log?.info(`Processing INDIVIDUAL message from: ${contactName} (${whatsappNumber})`)

      topicId = await getOrCreateTopic(identifier, displayName)

      // Send text message for individual chats (only if there's actual text content)
      if (m.body && m.body.trim() && (!m.mimetype || m.mimetype.startsWith("text/"))) {
        const sendOptions = {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
          message_thread_id: topicId,
        }

        try {
          const sentMessage = await sendToTelegramWithRetry(
            config.telegram.groupId,
            m.body,
            sendOptions,
            identifier,
            displayName,
          )

          // Map Telegram message to WhatsApp message for replies
          if (sentMessage && sentMessage.message_id && m.id) {
            chatMessageMapping[sentMessage.message_id] = m.id
          }

          global.log?.info(`✅ Individual message text sent to Telegram`)
        } catch (sendError) {
          global.log?.error("Error sending individual message text:", sendError.message)
        }
      }
    }

    if (!topicId) {
      global.log?.error("Failed to get or create topic")
      return
    }

    // Save user/group to database
    await DatabaseOps.saveUser({
      whatsapp_id: m.isGroup ? m.chat : m.sender,
      name: m.isGroup ? m.group?.subject : displayName,
      phone: m.isGroup ? `group_${m.chat}` : identifier,
    })

    // Save message to database
    await DatabaseOps.saveMessage({
      message_id: m.id,
      sender: m.sender,
      chat: m.chat,
      content: m.body || "Media message",
      message_type: m.type || "text",
    })

    // Handle contact messages
    if (m.type === "contactMessage" || m.type === "contactsArrayMessage") {
      try {
        if (m.message?.contactMessage) {
          const contact = m.message.contactMessage

          // Send as actual Telegram contact
          const contactOptions = {
            message_thread_id: topicId,
          }

          // Extract phone number from vcard
          let phoneNumber = null
          if (contact.vcard) {
            const phoneMatch = contact.vcard.match(/TEL[^:]*:([^\n\r]+)/i)
            if (phoneMatch) {
              phoneNumber = phoneMatch[1].trim().replace(/[^\d+]/g, "")
            }
          }

          if (phoneNumber) {
            const sentMessage = await telegramBot.sendContact(
              config.telegram.groupId,
              phoneNumber,
              contact.displayName || "Unknown Contact",
              contactOptions,
            )

            // Map message for replies
            if (sentMessage && sentMessage.message_id && m.id) {
              chatMessageMapping[sentMessage.message_id] = m.id
            }

            // Add sender info for group messages
            if (m.isGroup) {
              const senderInfo = `👤 **${m.name}** shared a contact`
              await sendToTelegramWithRetry(
                config.telegram.groupId,
                senderInfo,
                {
                  parse_mode: "Markdown",
                  message_thread_id: topicId,
                },
                identifier,
                displayName,
              )
            }

            global.log?.info(`✅ Contact forwarded to Telegram as actual contact`)
          } else {
            // Fallback to text if no phone number found
            let contactText = `👤 **Contact Shared**\n\n📝 *Name:* ${contact.displayName || "Unknown"}`
            if (m.isGroup) {
              contactText = `👤 **${m.name}**: ${contactText}`
            }

            await sendToTelegramWithRetry(
              config.telegram.groupId,
              contactText,
              {
                parse_mode: "Markdown",
                message_thread_id: topicId,
              },
              identifier,
              displayName,
            )
          }
        } else if (m.message?.contactsArrayMessage) {
          const contacts = m.message.contactsArrayMessage.contacts || []

          // Send each contact separately as actual Telegram contacts
          for (let i = 0; i < contacts.length; i++) {
            const contact = contacts[i]

            let phoneNumber = null
            if (contact.vcard) {
              const phoneMatch = contact.vcard.match(/TEL[^:]*:([^\n\r]+)/i)
              if (phoneMatch) {
                phoneNumber = phoneMatch[1].trim().replace(/[^\d+]/g, "")
              }
            }

            if (phoneNumber) {
              const contactOptions = {
                message_thread_id: topicId,
              }

              const sentMessage = await telegramBot.sendContact(
                config.telegram.groupId,
                phoneNumber,
                contact.displayName || `Contact ${i + 1}`,
                contactOptions,
              )

              // Map message for replies (only for the first contact)
              if (i === 0 && sentMessage && sentMessage.message_id && m.id) {
                chatMessageMapping[sentMessage.message_id] = m.id
              }
            }
          }

          // Add sender info for group messages
          if (m.isGroup) {
            const senderInfo = `👤 **${m.name}** shared ${contacts.length} contact${contacts.length > 1 ? "s" : ""}`
            await sendToTelegramWithRetry(
              config.telegram.groupId,
              senderInfo,
              {
                parse_mode: "Markdown",
                message_thread_id: topicId,
              },
              identifier,
              displayName,
            )
          }

          global.log?.info(`✅ ${contacts.length} contacts forwarded to Telegram as actual contacts`)
        }
      } catch (contactError) {
        global.log?.error("Error forwarding contact:", contactError.message)
      }
    }

    // Handle location messages
    if (m.type === "locationMessage") {
      try {
        const location = m.message?.locationMessage

        if (location?.degreesLatitude && location?.degreesLongitude) {
          // Send as actual Telegram location
          const locationOptions = {
            message_thread_id: topicId,
          }

          // Add caption for group messages to show sender
          if (m.isGroup) {
            locationOptions.caption = `👤 **${m.name}**`
            locationOptions.parse_mode = "Markdown"
          }

          const sentMessage = await telegramBot.sendLocation(
            config.telegram.groupId,
            location.degreesLatitude,
            location.degreesLongitude,
            locationOptions,
          )

          // Map message for replies
          if (sentMessage && sentMessage.message_id && m.id) {
            chatMessageMapping[sentMessage.message_id] = m.id
          }

          // Send additional info if available
          if (location.name || location.address) {
            let locationInfo = ""
            if (location.name) locationInfo += `📝 *Name:* ${location.name}\n`
            if (location.address) locationInfo += `🏠 *Address:* ${location.address}`

            if (locationInfo) {
              const infoOptions = {
                parse_mode: "Markdown",
                disable_web_page_preview: true,
                message_thread_id: topicId,
              }

              if (m.isGroup) {
                locationInfo = `👤 **${m.name}**: ${locationInfo}`
              }

              await sendToTelegramWithRetry(config.telegram.groupId, locationInfo, infoOptions, identifier, displayName)
            }
          }

          global.log?.info(`✅ Location forwarded to Telegram as actual location`)
        }
      } catch (locationError) {
        global.log?.error("Error forwarding location:", locationError.message)
      }
    }

    // Forward media if enabled and available
    if (config.telegram.forwardMedia && m.mimetype && !m.mimetype.startsWith("text/")) {
      try {
        const mediaBuffer = await m.download()

        const mediaOptions = {
          message_thread_id: topicId,
        }

        // Add caption for group messages to show sender
        if (m.isGroup) {
          mediaOptions.caption = `👤 **${m.name}**${m.body ? `: ${m.body}` : ""}`
        } else if (m.body && m.body.trim()) {
          mediaOptions.caption = m.body
        }

        // Handle different media types
        if (m.type === "stickerMessage" || (m.mimetype === "image/webp" && m.message?.stickerMessage)) {
          try {
            const isAnimated = m.message?.stickerMessage?.isAnimated || m.message?.stickerMessage?.animated || false

            if (isAnimated && ffmpegAvailable) {
              const mp4Buffer = await convertAnimatedWebPToMP4(mediaBuffer)
              const sentMessage = await telegramBot.sendAnimation(config.telegram.groupId, mp4Buffer, {
                message_thread_id: topicId,
                caption: mediaOptions.caption || "🎭 Animated Sticker",
              })

              // Map message for replies
              if (sentMessage && sentMessage.message_id && m.id) {
                chatMessageMapping[sentMessage.message_id] = m.id
              }
            } else {
              const sentMessage = await telegramBot.sendSticker(config.telegram.groupId, mediaBuffer, {
                message_thread_id: topicId,
              })

              // Map message for replies
              if (sentMessage && sentMessage.message_id && m.id) {
                chatMessageMapping[sentMessage.message_id] = m.id
              }
            }
          } catch (stickerError) {
            const sentMessage = await telegramBot.sendPhoto(config.telegram.groupId, mediaBuffer, {
              message_thread_id: topicId,
              caption: mediaOptions.caption || "🎭 Sticker (as image)",
            })

            // Map message for replies
            if (sentMessage && sentMessage.message_id && m.id) {
              chatMessageMapping[sentMessage.message_id] = m.id
            }
          }
        } else if (m.mimetype.startsWith("image/")) {
          if (m.mimetype === "image/gif") {
            const sentMessage = await telegramBot.sendAnimation(config.telegram.groupId, mediaBuffer, mediaOptions)
            if (sentMessage && sentMessage.message_id && m.id) {
              chatMessageMapping[sentMessage.message_id] = m.id
            }
          } else {
            const sentMessage = await telegramBot.sendPhoto(config.telegram.groupId, mediaBuffer, mediaOptions)
            if (sentMessage && sentMessage.message_id && m.id) {
              chatMessageMapping[sentMessage.message_id] = m.id
            }
          }
        } else if (m.mimetype.startsWith("video/")) {
          const sentMessage = await telegramBot.sendVideo(config.telegram.groupId, mediaBuffer, mediaOptions)
          if (sentMessage && sentMessage.message_id && m.id) {
            chatMessageMapping[sentMessage.message_id] = m.id
          }
        } else if (m.mimetype.startsWith("audio/")) {
          if (m.type === "audioMessage" && m.message?.audioMessage?.ptt) {
            const sentMessage = await telegramBot.sendVoice(config.telegram.groupId, mediaBuffer, mediaOptions)
            if (sentMessage && sentMessage.message_id && m.id) {
              chatMessageMapping[sentMessage.message_id] = m.id
            }
          } else {
            const sentMessage = await telegramBot.sendAudio(config.telegram.groupId, mediaBuffer, mediaOptions)
            if (sentMessage && sentMessage.message_id && m.id) {
              chatMessageMapping[sentMessage.message_id] = m.id
            }
          }
        } else {
          mediaOptions.filename = `document_${Date.now()}.${m.mimetype.split("/")[1] || "bin"}`
          const sentMessage = await telegramBot.sendDocument(config.telegram.groupId, mediaBuffer, mediaOptions)
          if (sentMessage && sentMessage.message_id && m.id) {
            chatMessageMapping[sentMessage.message_id] = m.id
          }
        }

        global.log?.info(`✅ Media forwarded to Telegram`)
      } catch (mediaError) {
        global.log?.error("Error forwarding media to Telegram:", mediaError.message)
      }
    }

    global.log?.info(`✅ Message forwarded to Telegram topic: ${topicId}`)
  } catch (error) {
    global.log?.error("Error forwarding to Telegram:", error.message)
  }
}

// Get Telegram bot info
async function getTelegramBotInfo() {
  if (!telegramBot) {
    return null
  }

  try {
    const botInfo = await telegramBot.getMe()
    return botInfo
  } catch (error) {
    global.log?.error("Error getting Telegram bot info:", error.message)
    return null
  }
}

// Get topic mappings
async function getTopicMappings() {
  return { topicMapping, reverseTopicMapping }
}

module.exports = {
  initTelegramBot,
  forwardToTelegram,
  forwardStatusToTelegram,
  forwardCallToTelegram,
  getTelegramBotInfo,
  getTopicMappings,
  telegramBot: () => telegramBot,
}
