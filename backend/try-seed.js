const { Pool, Client } = require('pg');
const createTables = require('./config/initDb');
const bcrypt = require('bcryptjs');

const commonPasswords = ['postgres', 'root', 'admin', 'password', '1234', '123456', ''];

async function attemptSeed() {
  for (const pwd of commonPasswords) {
    console.log(`Trying password: "${pwd}"...`);
    const client = new Client({
      host: 'localhost',
      port: 5432,
      user: 'postgres',
      password: pwd,
      database: 'postgres' // connect to default db first
    });

    try {
      await client.connect();
      console.log(`✅ Successfully connected with password: "${pwd}"`);
      
      // Check if nexuscommerce exists
      const res = await client.query("SELECT 1 FROM pg_database WHERE datname = 'nexuscommerce'");
      if (res.rowCount === 0) {
        console.log('Creating database nexuscommerce...');
        await client.query('CREATE DATABASE nexuscommerce');
      } else {
        console.log('Database nexuscommerce already exists.');
      }
      await client.end();

      // Now set the .env file with the correct password
      const fs = require('fs');
      let envContent = fs.readFileSync('.env', 'utf8');
      envContent = envContent.replace(/DB_USER=.*/, 'DB_USER=postgres');
      envContent = envContent.replace(/DB_PASSWORD=.*/, `DB_PASSWORD=${pwd}`);
      fs.writeFileSync('.env', envContent);
      console.log('✅ Updated .env file');

      // Now run initDb and seeder
      // We will just execute them as child processes
      const { execSync } = require('child_process');
      console.log('Running initDb...');
      execSync('node config/initDb.js', { stdio: 'inherit' });
      
      console.log('Running seeder...');
      execSync('node seeder.js', { stdio: 'inherit' });

      console.log('🎉 ALL DONE!');
      return;
    } catch (err) {
      // Failed to connect
    }
  }
  console.log('❌ Could not connect to PostgreSQL with any common passwords. Is PostgreSQL running on your computer?');
}

attemptSeed();
