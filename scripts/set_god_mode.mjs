#!/usr/bin/env node
// Set a character to invincible GM mode with maximum firepower.
//
//   node scripts/set_god_mode.mjs <character_name>
//
// This script:
// 1. Sets the character to GM mode (invulnerable)
// 2. Sets level to 20 (max level)
// 3. Maximizes all stats and attack power
// 4. Sets weapon to maximum damage
//
// Uses DATABASE_URL. For local dev, copy .env.example to .env first.
import pg from 'pg';

try {
  process.loadEnvFile?.();
} catch {
  // .env is optional; production operators may pass DATABASE_URL directly.
}

const characterName = process.argv[2];

if (!characterName || characterName.startsWith('--')) {
  console.error('usage: node scripts/set_god_mode.mjs <character_name>');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required. For local dev, copy .env.example to .env first.');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString });

try {
  // Find the character
  const charRes = await pool.query(
    'SELECT id, account_id, name, class, level, is_gm, state FROM characters WHERE name = $1',
    [characterName],
  );
  
  if (charRes.rowCount === 0) {
    console.error(`no character named "${characterName}" found`);
    process.exit(1);
  }
  
  const char = charRes.rows[0];
  console.log(`Found character: ${char.name} (${char.class}, level ${char.level}, is_gm: ${char.is_gm})`);
  
  // Set to GM mode and max level
  const updateRes = await pool.query(
    'UPDATE characters SET is_gm = TRUE, level = 20 WHERE id = $1 RETURNING id, name, class, level, is_gm',
    [char.id],
  );
  
  const updated = updateRes.rows[0];
  console.log(`✓ Set ${updated.name} to GM mode (invulnerable) and level 20`);
  
  // Update character state with god-like stats
  let state = char.state;
  if (typeof state === 'string') {
    try {
      state = JSON.parse(state);
    } catch (e) {
      console.error('failed to parse character state:', e.message);
      state = {};
    }
  }
  
  // Enhance state with maximum stats
  if (typeof state === 'object' && state !== null) {
    // Maximize stats
    state.lvl = 20;
    
    // Set copper to max for buying anything
    state.copper = 99999999;
    
    // Add god-like equipment if not present
    if (!state.equip) state.equip = {};
    
    // Give a legendary weapon with max damage
    state.equip.mainhand = 'god_weapon';
    
    // Add max stats to state
    if (!state.stats) state.stats = {};
    state.stats = {
      str: 999,
      agi: 999,
      sta: 999,
      int: 999,
      spi: 999,
      armor: 9999
    };
    
    // Update the state in database
    await pool.query(
      'UPDATE characters SET state = $1 WHERE id = $2',
      [JSON.stringify(state), char.id],
    );
    
    console.log(`✓ Enhanced ${updated.name} with god-like stats and equipment`);
  }
  
  console.log(`\nCharacter ${updated.name} is now:`);
  console.log(`  - Invulnerable (GM mode)`);
  console.log(`  - Level 20 (max level)`);
  console.log(`  - Maximum stats (STR/AGI/STA/INT/SPI: 999)`);
  console.log(`  - Maximum armor (9999)`);
  console.log(`  - Unlimited gold (99,999,999 copper)`);
  console.log(`  - God weapon equipped`);
  
} catch (err) {
  console.error('failed:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}