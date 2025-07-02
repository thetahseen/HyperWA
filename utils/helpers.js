
const logger = require('../Core/logger');
const config = require('../config');

class Helpers {
    // FIXED: Smart error handling that edits the ORIGINAL command message
    static async smartErrorRespond(bot, originalMsg, options = {}) {
        const {
            processingText = '⏳ Processing...',
            errorText = '❌ Something went wrong.',
            actionFn,
            autoReact = config.get('features.autoReact'),
            editMessages = config.get('features.editMessages')
        } = options;

        const sender = originalMsg.key.remoteJid;

        try {
            // React with processing emoji on the ORIGINAL command message
            if (autoReact) {
                try {
                    await bot.sock.sendMessage(sender, {
                        react: { key: originalMsg.key, text: '⏳' }
                    });
                } catch (reactError) {
                    logger.debug('Failed to react with processing:', reactError);
                }
            }

            // FIXED: Edit the ORIGINAL command message instead of creating new one
            if (config.get('features.smartProcessing') && editMessages) {
                try {
                    await bot.sock.sendMessage(sender, {
                        text: processingText,
                        edit: originalMsg.key
                    });
                } catch (editError) {
                    logger.debug('Failed to edit original message with processing text:', editError);
                    // Fallback: send new message
                    await bot.sendMessage(sender, { text: processingText });
                }
            }

            // Execute the action
            const result = await actionFn();

            // Success reaction on original message
            if (autoReact) {
                try {
                    await bot.sock.sendMessage(sender, {
                        react: { key: originalMsg.key, text: '✅' }
                    });
                } catch (reactError) {
                    logger.debug('Failed to react with success:', reactError);
                }
            }

            // FIXED: Edit the ORIGINAL command message with result
            if (editMessages && result && typeof result === 'string') {
                try {
                    await bot.sock.sendMessage(sender, {
                        text: result,
                        edit: originalMsg.key
                    });
                } catch (editError) {
                    logger.debug('Failed to edit original message with result:', editError);
                    // Fallback: send new message
                    await bot.sendMessage(sender, { text: result });
                }
            } else if (editMessages && !result) {
                // Edit with success message if no result returned
                try {
                    await bot.sock.sendMessage(sender, {
                        text: '✅ Command completed successfully!',
                        edit: originalMsg.key
                    });
                } catch (editError) {
                    logger.debug('Failed to edit original message with success:', editError);
                }
            }

            return result;

        } catch (error) {
            logger.error('Error in smartErrorRespond:', error);

            // Error reaction on original message
            if (autoReact) {
                try {
                    await bot.sock.sendMessage(sender, {
                        react: { key: originalMsg.key, text: '❌' }
                    });
                } catch (reactError) {
                    logger.debug('Failed to react with error:', reactError);
                }
            }

            // FIXED: Edit the ORIGINAL command message with error
            const finalErrorText = `${errorText}\n\n🔍 Error: ${error.message}`;
            
            if (editMessages) {
                try {
                    await bot.sock.sendMessage(sender, {
                        text: finalErrorText,
                        edit: originalMsg.key
                    });
                } catch (editError) {
                    logger.debug('Failed to edit original message with error:', editError);
                    // Fallback: send new message
                    await bot.sendMessage(sender, { text: finalErrorText });
                }
            } else {
                await bot.sendMessage(sender, { text: finalErrorText });
            }

            throw error;
        }
    }

    // Format uptime
    static formatUptime(startTime) {
        const seconds = Math.floor((Date.now() - startTime) / 1000);
        const days = Math.floor(seconds / (3600 * 24));
        const hours = Math.floor((seconds % (3600 * 24)) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        return `${days}d ${hours}h ${minutes}m ${secs}s`;
    }

    // Format file size
    static formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // Clean phone number
    static cleanPhoneNumber(phone) {
        return phone.replace(/[^\d]/g, '');
    }

    // Check if user is owner
    static isOwner(participant) {
        const owner = config.get('bot.owner');
        return participant === owner;
    }

    // Generate random string
    static generateRandomString(length = 8) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    // Sleep function
    static sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = Helpers;
