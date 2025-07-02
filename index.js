const { HyperWaBot } = require('./Core/bot');
const logger = require('./Core/logger');
const config = require('./config');
global.crypto = require('crypto');

async function main() {
    try {
        logger.info('🚀 Starting HyperWa Userbot...');
        logger.info(`🎯 Version: ${config.get('bot.version')}`);
        logger.info(`🏢 Company: ${config.get('bot.company')}`);
        
        const bot = new HyperWaBot();
        await bot.initialize();
        
        // Graceful shutdown handlers
        process.on('SIGINT', async () => {
            logger.info('🛑 Received SIGINT, shutting down gracefully...');
            await bot.shutdown();
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            logger.info('🛑 Received SIGTERM, shutting down gracefully...');
            await bot.shutdown();
            process.exit(0);
        });

        process.on('uncaughtException', (error) => {
            logger.error('💥 Uncaught Exception:', error);
            process.exit(1);
        });

        process.on('unhandledRejection', (reason, promise) => {
            logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
            process.exit(1);
        });

    } catch (error) {
        logger.error('💥 Failed to start HyperWa Userbot:', error);
        process.exit(1);
    }
}

// Display startup banner
console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║    ██╗  ██╗██╗   ██╗██████╗ ███████╗██████╗ ██╗    ██╗ █████╗ ║
║    ██║  ██║╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗██║    ██║██╔══██╗║
║    ███████║ ╚████╔╝ ██████╔╝█████╗  ██████╔╝██║ █╗ ██║███████║║
║    ██╔══██║  ╚██╔╝  ██╔═══╝ ██╔══╝  ██╔══██╗██║███╗██║██╔══██║║
║    ██║  ██║   ██║   ██║     ███████╗██║  ██║╚███╔███╔╝██║  ██║║
║    ╚═╝  ╚═╝   ╚═╝   ╚═╝     ╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═╝  ╚═╝║
║                                                              ║
║                    Advanced WhatsApp Userbot                ║
║                      Version 3.0.0                          ║
║                  Dawium Technologies                        ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);

main();
