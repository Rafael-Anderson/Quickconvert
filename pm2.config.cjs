module.exports = {
  apps: [
    {
      name: "quickextract",
      script: "node_modules/.bin/next",
      args: "start",
      max_memory_restart: "1400M",
      instances: 1,
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
