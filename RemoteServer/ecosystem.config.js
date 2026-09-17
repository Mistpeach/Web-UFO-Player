// ============================================================
// RemoteServer/ecosystem.config.js - PM2 进程守护配置
//
//   用法（在 RemoteServer 目录下）：
//     npm install -g pm2
//     pm2 start ecosystem.config.js
//     pm2 save            # 保存当前进程列表
//     pm2 startup         # 生成开机自启脚本，按提示再执行它打印的那条命令
//     pm2 logs ufo-remote # 看实时日志
//     pm2 restart ufo-remote --update-env
//
//   说明：这里的 out_file / error_file 只是 PM2 自己抓的 stdout/stderr 副本；
//   服务器真正的结构化日志在 logs/access.log 与 logs/error.log（自己轮转，保留 14 天）。
// ============================================================
module.exports = {
  apps: [
    {
      name: 'ufo-remote',
      script: 'server.js',
      cwd: __dirname,

      // 中继服务器是「有状态」的：房间表在内存里，所以绝对不能开 cluster 多实例，
      // 否则两个客户端可能被分到不同进程，互相看不见。
      instances: 1,
      exec_mode: 'fork',

      // 崩溃自动重启（内存泄漏到 512MB 也重启一次，作为兜底）
      autorestart: true,
      max_memory_restart: '512M',
      min_uptime: '10s',
      max_restarts: 20,
      restart_delay: 2000,

      // SIGINT 让 server.js 走优雅关闭（断开所有连接 + 写停止日志）
      kill_timeout: 5000,
      listen_timeout: 10000,

      env: {
        NODE_ENV: 'production',
        UFO_PORT: '8787',
        UFO_HOST: '0.0.0.0',
        UFO_LOG_LEVEL: 'info',
        UFO_LOG_IP_MODE: 'full'
      },

      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true
    }
  ]
};
