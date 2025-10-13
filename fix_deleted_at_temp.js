// Temporary script to comment out deleted_at references
// Run this with: node backend/fix_deleted_at_temp.js

const fs = require('fs');
const path = require('path');

const routeFiles = [
  'backend/routes/inventory.js',
  'backend/routes/dashboard.js', 
  'backend/routes/reports.js',
  'backend/routes/customers.js',
  'backend/routes/orders.js',
  'backend/routes/settings.js',
  'backend/routes/profile.js'
];

function fixDeletedAtReferences(filePath) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Replace WHERE clauses with deleted_at
    content = content.replace(/WHERE\s+([a-z]+\.)?deleted_at\s+IS\s+NULL/gi, 'WHERE 1=1 -- deleted_at check temporarily disabled');
    
    // Replace AND clauses with deleted_at
    content = content.replace(/AND\s+([a-z]+\.)?deleted_at\s+IS\s+NULL/gi, '-- AND $1deleted_at IS NULL -- temporarily disabled');
    
    // Replace complex WHERE clauses that include deleted_at
    content = content.replace(/WHERE\s+([^;]+)\s+AND\s+([a-z]+\.)?deleted_at\s+IS\s+NULL/gi, 'WHERE $1 -- AND $2deleted_at IS NULL temporarily disabled');
    
    fs.writeFileSync(filePath, content);
    console.log(`✅ Fixed ${filePath}`);
  } catch (error) {
    console.log(`❌ Error fixing ${filePath}:`, error.message);
  }
}

console.log('🔧 Temporarily fixing deleted_at references...');

routeFiles.forEach(filePath => {
  if (fs.existsSync(filePath)) {
    fixDeletedAtReferences(filePath);
  } else {
    console.log(`⚠️  File not found: ${filePath}`);
  }
});

console.log('\n✅ Temporary fix completed!');
console.log('📝 Note: Run the database migration when ready to restore deleted_at functionality');
console.log('🗄️  Migration file: backend/database/add_deleted_at_migration.sql');