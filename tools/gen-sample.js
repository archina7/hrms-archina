// data/sample.json 생성 스크립트
// 사용법: node tools/gen-sample.js .   (프로젝트 루트 경로를 인자로)
// index.html의 <script id="core"> 블록을 실행해 buildSampleData() 결과를 저장한다.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.resolve(process.argv[2] || '.');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const match = html.match(/<script id="core">([\s\S]*?)<\/script>/);
if (!match) { console.error('index.html에서 core 스크립트를 찾을 수 없습니다.'); process.exit(1); }

const ctx = {};
vm.createContext(ctx);
vm.runInContext(match[1] + '\n;this.out = { data: buildSampleData(), version: SCHEMA_VERSION };', ctx);
const { data, version } = ctx.out;

const payload = {
  app: 'construction-hrms',
  schemaVersion: version,
  exportedAt: '2026-11-19T09:00:00',
  note: '모든 인물·회사·연락처는 가상 데이터입니다.',
  ...data,
};
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'sample.json'), JSON.stringify(payload, null, 2), 'utf8');
for (const k of Object.keys(data)) console.log(`${k}: ${data[k].length}건`);
console.log('→ data/sample.json 저장 완료');
