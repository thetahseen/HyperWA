const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');

const config = require('../config');
const logger = require('./logger');
const MessageHandler = require('./message-handler');
const TelegramBridge = require('../watg-bridge/bridge');
const { connectDb } = require('../utils/db');
const ModuleLoader = require('./module-loader');

class HyperWaBot {
    constructor() {
        this.sock = null;
        this.authPath = './auth_info';
        this.messageHandler = new MessageHandler(this);
        this.telegramBridge = null;
        this.isShuttingDown = false;
        this.db = null;
        this.moduleLoader = new ModuleLoader(this);
        this.qrCodeSent = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 5000;
    }

    async initialize() {
        logger.info('🔧 Initializing HyperWa Userbot...');
        
        // Connect to the database
        try {
            this.db = await connectDb();
            logger.info('✅ Database connected successfully!');
        } catch (error) {
            logger.error('❌ Failed to connect to database:', error);
            process.exit(1);
        }

        // Initialize Telegram bridge first (for QR code sending)
        if (config.get('telegram.enabled')) {
            try {
                this.telegramBridge = new TelegramBridge(this);
                await this.telegramBridge.initialize();
                logger.info('✅ Telegram bridge initialized');
            } catch (error) {
                logger.error('❌ Failed to initialize Telegram bridge:', error);
            }
        }

        // Load modules using the ModuleLoader
        await this.moduleLoader.loadModules();
        
        // Start WhatsApp connection
        await this.startWhatsApp();
        
        logger.info('✅ HyperWa Userbot initialized successfully!');
    }

    async startWhatsApp() {
        try {
            const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
            const { version } = await fetchLatestBaileysVersion();

            this.sock = makeWASocket({
                auth: state,
                version,
                printQRInTerminal: false,
                logger: logger.child({ module: 'baileys' }),
                getMessage: async (key) => ({ conversation: 'Message not found' }),
                // Enhanced connection options
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
                markOnlineOnConnect: true,
                syncFullHistory: false,
                browser: ['HyperWa', 'Chrome', '3.0'],
                // Prevent multiple connections
                shouldIgnoreJid: jid => jid === 'status@broadcast',
                // Enhanced retry configuration
                retryRequestDelayMs: 250,
                maxMsgRetryCount: 5,
                // Connection stability
                emitOwnEvents: false,
                fireInitQueries: true,
                generateHighQualityLinkPreview: false
            });

            this.setupEventHandlers(saveCreds);
            
            // Set connection timeout
            const connectionTimeout = setTimeout(() => {
                if (!this.sock?.user && !this.isShuttingDown) {
                    logger.warn('❌ Connection timed out, retrying...');
                    this.handleReconnection();
                }
            }, 60000);

            // Wait for connection
            await new Promise((resolve, reject) => {
                const cleanup = () => {
                    clearTimeout(connectionTimeout);
                };

                this.sock.ev.on('connection.update', (update) => {
                    if (update.connection === 'open') {
                        cleanup();
                        this.reconnectAttempts = 0; // Reset on successful connection
                        resolve();
                    } else if (update.connection === 'close') {
                        cleanup();
                        // Don't reject here, let the connection.update handler deal with it
                    }
                });

                // Handle errors
                this.sock.ev.on('creds.update', () => {
                    // Connection is progressing
                });
            });

        } catch (error) {
            logger.error('❌ Failed to initialize WhatsApp socket:', error);
            await this.handleReconnection();
        }
    }

    async handleReconnection() {
        if (this.isShuttingDown) return;

        this.reconnectAttempts++;
        
        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            logger.error('❌ Max reconnection attempts reached. Please restart the bot.');
            process.exit(1);
        }

        const delay = this.reconnectDelay * this.reconnectAttempts;
        logger.warn(`🔄 Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay/1000}s...`);
        
        // Clean up current socket
        if (this.sock) {
            try {
                this.sock.end();
            } catch (error) {
                logger.debug('Error ending socket:', error);
            }
            this.sock = null;
        }

        setTimeout(() => {
            if (!this.isShuttingDown) {
                this.startWhatsApp();
            }
        }, delay);
    }

    setupEventHandlers(saveCreds) {
        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                logger.info('📱 Scan QR code with WhatsApp:');
                qrcode.generate(qr, { small: true });

                // Send QR code to Telegram if bridge is enabled
                if (this.telegramBridge && config.get('telegram.enabled') && config.get('telegram.botToken')) {
                    try {
                        await this.telegramBridge.sendQRCode(qr);
                        logger.info('✅ QR code sent to Telegram');
                    } catch (error) {
                        logger.error('❌ Failed to send QR code to Telegram:', error);
                    }
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.output?.payload?.error;
                
                logger.warn(`🔌 Connection closed: ${reason || 'Unknown reason'} (${statusCode})`);

                // Handle different disconnect reasons
                switch (statusCode) {
                    case DisconnectReason.badSession:
                        logger.error('❌ Bad session file, deleting and restarting...');
                        await fs.remove(this.authPath);
                        await this.handleReconnection();
                        break;
                        
                    case DisconnectReason.connectionClosed:
                    case DisconnectReason.connectionLost:
                    case DisconnectReason.connectionReplaced:
                        if (!this.isShuttingDown) {
                            logger.warn('🔄 Connection issue, reconnecting...');
                            await this.handleReconnection();
                        }
                        break;
                        
                    case DisconnectReason.loggedOut:
                        logger.error('❌ Logged out from WhatsApp. Please delete auth_info and restart.');
                        await fs.remove(this.authPath);
                        process.exit(1);
                        break;
                        
                    case DisconnectReason.restartRequired:
                        logger.warn('🔄 Restart required, restarting...');
                        await this.handleReconnection();
                        break;
                        
                    case DisconnectReason.timedOut:
                        logger.warn('⏰ Connection timed out, retrying...');
                        await this.handleReconnection();
                        break;
                        
                    default:
                        if (!this.isShuttingDown) {
                            logger.warn('🔄 Unknown disconnect reason, reconnecting...');
                            await this.handleReconnection();
                        }
                        break;
                }
            } else if (connection === 'open') {
                await this.onConnectionOpen();
            } else if (connection === 'connecting') {
                logger.info('🔗 Connecting to WhatsApp...');
            }
        });

        // Enhanced error handling
        this.sock.ev.on('creds.update', saveCreds);
        
        this.sock.ev.on('messages.upsert', async (m) => {
            try {
                await this.messageHandler.handleMessages(m);
            } catch (error) {
                logger.error('❌ Error handling message:', error);
            }
        });

        // Handle socket errors
        this.sock.ev.on('error', (error) => {
            logger.error('❌ Socket error:', error);
        });
    }

async onConnectionOpen() {
    logger.info(`✅ Connected to WhatsApp! User: ${this.sock.user?.id || 'Unknown'}`);
    
    // Set owner if not set
    if (!config.get('bot.owner') && this.sock.user) {
        config.set('bot.owner', this.sock.user.id);
        logger.info(`👑 Owner set to: ${this.sock.user.id}`);
    }

    // Setup WhatsApp handlers and sync contacts for Telegram bridge
    if (this.telegramBridge) {
        await this.telegramBridge.setupWhatsAppHandlers();
        await this.telegramBridge.syncContacts(); // Added contact sync on connection
    }

    // Send startup message to owner and Telegram
    await this.sendStartupMessage();
    
    // Notify Telegram bridge of connection
    if (this.telegramBridge) {
        await this.telegramBridge.syncWhatsAppConnection();
    }
}

    async sendStartupMessage() {
        const owner = config.get('bot.owner');
        if (!owner) return;

        const startupMessage = `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
                              `🔥 *HyperWa Features Active:*\n` +
                              `• 📱 Modular Architecture\n` +
                              `• 🤖 Telegram Bridge: ${config.get('telegram.enabled') ? '✅' : '❌'}\n` +
                              `• 🔧 Custom Modules: ${config.get('features.customModules') ? '✅' : '❌'}\n` +
                              `Type *${config.get('bot.prefix')}help* for available commands!`;

        try {
            await this.sock.sendMessage(owner, { text: startupMessage });
            
            if (this.telegramBridge) {
                await this.telegramBridge.logToTelegram('🚀 HyperWa Bot Started', startupMessage);
            }
        } catch (error) {
            logger.error('Failed to send startup message:', error);
        }
    }

    async connect() {
        if (!this.sock) {
            await this.startWhatsApp();
        }
        return this.sock;
    }

    async sendMessage(jid, content) {
        if (!this.sock) {
            throw new Error('WhatsApp socket not initialized');
        }
        return await this.sock.sendMessage(jid, content);
    }

    async shutdown() {
        logger.info('🛑 Shutting down HyperWa Userbot...');
        this.isShuttingDown = true;
        
        if (this.telegramBridge) {
            await this.telegramBridge.shutdown();
        }
        
        if (this.sock) {
            try {
                await this.sock.end();
            } catch (error) {
                logger.debug('Error ending WhatsApp socket:', error);
            }
        }
        
        logger.info('✅ HyperWa Userbot shutdown complete');
    }
}

module.exports = { HyperWaBot };
