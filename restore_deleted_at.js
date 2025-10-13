const fs = require('fs')
const path = require('path')

const routesDir = path.join(__dirname, 'routes')

// Get all JavaScript files in routes directory
const routeFiles = fs.readdirSync(routesDir)
  .filter(file => file.endsWith('.js'))

console.log('Restoring deleted_at checks in route files...')

let totalChanges = 0

routeFiles.forEach(filename => {
  const filepath = path.join(routesDir, filename)
  let content = fs.readFileSync(filepath, 'utf8')
  let fileChanges = 0
  
  // Pattern 1: WHERE clauses with commented deleted_at checks
  const pattern1 = /WHERE u\.id = \$1 -- AND u\.deleted_at IS NULL -- temporarily disabled/g
  if (content.match(pattern1)) {
    content = content.replace(pattern1, 'WHERE u.id = $1 AND u.deleted_at IS NULL')
    fileChanges++
  }
  
  // Pattern 2: WHERE clauses with generic deleted_at checks 
  const pattern2 = /WHERE (.+?) -- AND \1\.deleted_at IS NULL -- temporarily disabled/g
  content = content.replace(pattern2, 'WHERE $1 AND $1.deleted_at IS NULL')
  
  // Pattern 3: WHERE 1=1 with deleted_at comment
  const pattern3 = /WHERE 1=1 -- deleted_at check temporarily disabled/g
  if (content.match(pattern3)) {
    content = content.replace(pattern3, 'WHERE deleted_at IS NULL')
    fileChanges++
  }
  
  // Pattern 4: Complex WHERE clauses with deleted_at comments
  const pattern4 = /SELECT (.+?) FROM (\w+) (\w+)[^W]*WHERE 1=1 -- deleted_at check temporarily disabled/gs
  content = content.replace(pattern4, 'SELECT $1 FROM $2 $3 WHERE $3.deleted_at IS NULL')
  
  // Pattern 5: AND deleted_at IS NULL comments
  const pattern5 = / -- AND ([cp]|u|o|s|categories|products|customers|suppliers|orders)\.deleted_at IS NULL -- temporarily disabled/g
  content = content.replace(pattern5, ' AND $1.deleted_at IS NULL')
  
  // Pattern 6: Generic AND deleted_at IS NULL comments  
  const pattern6 = / -- -- AND deleted_at IS NULL temporarily disabled -- temporarily disabled/g
  if (content.match(pattern6)) {
    content = content.replace(pattern6, ' AND deleted_at IS NULL')
    fileChanges++
  }
  
  // Pattern 7: Simple deleted_at IS NULL comments
  const pattern7 = / -- AND deleted_at IS NULL -- temporarily disabled/g
  if (content.match(pattern7)) {
    content = content.replace(pattern7, ' AND deleted_at IS NULL')
    fileChanges++
  }
  
  // Pattern 8: Specific WHERE id patterns
  const pattern8 = / -- AND c\.deleted_at IS NULL -- temporarily disabled/g
  if (content.match(pattern8)) {
    content = content.replace(pattern8, ' AND c.deleted_at IS NULL')
    fileChanges++
  }
  
  // Pattern 9: Generic WHERE patterns with table alias
  const pattern9 = /WHERE ([a-z]+)\.id = \$1 -- AND \1\.deleted_at IS NULL -- temporarily disabled/g
  content = content.replace(pattern9, 'WHERE $1.id = $1 AND $1.deleted_at IS NULL')
  
  // Count actual changes made to this file
  const originalContent = fs.readFileSync(filepath, 'utf8')
  if (content !== originalContent) {
    fs.writeFileSync(filepath, content, 'utf8')
    totalChanges++
    console.log(`✓ Updated ${filename} - restored deleted_at checks`)
  }
})

console.log(`\nCompleted! Updated ${totalChanges} files.`)
console.log('\nNote: After running the database migration, all APIs should work with proper soft delete functionality.')