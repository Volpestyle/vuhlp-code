import winston from "winston";
import "winston-daily-rotate-file";
import path from "node:path";
import { type VuhlpConfig } from "../config.js";

let logger: winston.Logger;

export function initLogger(cfg: VuhlpConfig["logging"]): void {
    const logDir = cfg?.dir ?? "logs";
    const logLevel = cfg?.level ?? "info";
    const retention = cfg?.retentionDays ?? "14d";

    const fileTransport = new winston.transports.DailyRotateFile({
        filename: path.join(logDir, "application-%DATE%.log"),
        datePattern: "YYYY-MM-DD",
        zippedArchive: true,
        maxSize: "20m",
        maxFiles: retention,
        level: logLevel, // File gets everything up to this level
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
        ),
    });

    const consoleTransport = new winston.transports.Console({
        level: logLevel,
        format: winston.format.combine(
            winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
            winston.format.colorize(),
            winston.format.printf(({ level, message, timestamp, ...meta }) => {
                const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : "";
                return `[${timestamp}] ${level}: ${message} ${metaStr}`;
            })
        ),
    });

    logger = winston.createLogger({
        level: logLevel,
        defaultMeta: { service: "daemon" },
        transports: [
            consoleTransport,
            fileTransport,
        ],
    });

    logger.info("Logger initialized", {
        level: logLevel,
        dir: logDir,
        retention,
    });
}

// Export a proxy so we can import 'logger' but it only works after init
export const log = {
    debug: (msg: string, meta?: any) => logger?.debug(msg, meta),
    info: (msg: string, meta?: any) => logger?.info(msg, meta),
    warn: (msg: string, meta?: any) => logger?.warn(msg, meta),
    error: (msg: string, meta?: any) => logger?.error(msg, meta),
};
