// ecosystem.config.js
module.exports = {
  apps: [{
    name: "screenshot-service",
    script: "./server.js",
    watch: false,
    env: {
      NODE_ENV: "production",
      PORT: 3000
    },
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "logs/error.log",
    out_file: "logs/output.log",
    merge_logs: true,
    max_memory_restart: "1G",
  }]
}