const fs = require('fs');
const path = require('path');

const logPath = '/Users/tomassuares/.gemini/antigravity/brain/76c9a155-6448-41fa-b28d-1ba09cd11e2a/.system_generated/tasks/task-17879.log';
if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    console.log(`Log has ${lines.length} lines.`);
    lines.forEach((line, idx) => {
        if (line.toUpperCase().includes('MIQUEO') || line.includes('11859812') || line.includes('11918939') || line.includes('644144') || line.includes('5644144')) {
            console.log(`Line ${idx + 1}: ${line}`);
            // Print surrounding lines
            for (let j = Math.max(0, idx - 2); j <= Math.min(lines.length - 1, idx + 2); j++) {
                console.log(`  [Line ${j + 1}]: ${lines[j]}`);
            }
        }
    });
} else {
    console.log("Log file not found!");
}
