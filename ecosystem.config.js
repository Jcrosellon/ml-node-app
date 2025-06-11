module.exports = {
  apps: [
    {
      name: "ml-node-app",
      script: "index.js",
      args: "import 2",
      cron_restart: "0 21 * * *",
      log_file: "./logs/combined.log",
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      merge_logs: true
    }
  ]
};
