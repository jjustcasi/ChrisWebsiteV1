const fs = require('fs');
const path = require('path');

function calculateCertificationPoints(training = {}) {
  if (!training) return 0;
  // Consider certificate presence optional for this test; if a record has no certificate field,
  // still compute points based on hours and type to verify mapping.

  const type = String(training.type || '').trim().toLowerCase();
  const typeBonus = {
    'advance supervisory': 15,
    'basic supervisory': 10,
    'basic course': 5,
    managerial: 15,
    supervisory: 10,
    technical: 8,
    compliance: 5,
    foundation: 5,
  }[type] || 5;

  const hours = Number(training.hours || 0);
  const hoursBonus = Number.isFinite(hours) ? Math.floor(hours / 8) : 0;

  return 10 + hoursBonus + typeBonus;
}

const dbPath = path.join(__dirname, '..', 'data', 'local-db.json');
const raw = fs.readFileSync(dbPath, 'utf8');
const db = JSON.parse(raw);

const trainings = Array.isArray(db.trainings) ? db.trainings : [];
if (!trainings.length) {
  console.log('No training records found in data/local-db.json');
  process.exit(0);
}

console.log('Training certification points summary:');
trainings.forEach(tr => {
  const points = calculateCertificationPoints(tr);
  console.log(`- id:${tr.id} title:"${tr.title}" type:"${tr.type}" hours:${tr.hours} -> points:${points}`);
});

const total = trainings.reduce((s, t) => s + calculateCertificationPoints(t), 0);
console.log('Total points:', total);
