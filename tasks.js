const router = require('express').Router();
const prisma = require('../prisma');
const scheduleTasks = require('../utils/scheduler');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir });

router.get('/', async (req,res) => {
  try { res.json(await prisma.task.findMany({ include: { dependencies: true, assignments: { include: { user: true } } }, orderBy: { id: 'asc' } })); }
  catch(e){ console.error(e); res.status(500).json({error:'Tasks konnten nicht geladen werden'}); }
});
router.post('/', async (req,res) => {
  try { const { name, duration, description, status, type, phase } = req.body; if (!name || !duration) return res.status(400).json({error:'Name und Dauer erforderlich'}); res.json(await prisma.task.create({ data:{ name, duration:Number(duration), description:description||'', status:status||'OPEN', type:type||'TASK', phase:phase||'' } })); }
  catch(e){ console.error(e); res.status(500).json({error:'Task konnte nicht erstellt werden'}); }
});
router.post('/demo', async (req,res) => {
  try {
    await prisma.taskDependency.deleteMany(); await prisma.assignment.deleteMany(); await prisma.task.deleteMany();
    const demo = [
      ['Projekt Kickoff',1,'Initiierung','MILESTONE'],['Anforderungsanalyse',4,'Analyse','TASK'],['UX Konzept',3,'Konzeption','TASK'],['Datenmodell erstellen',2,'Konzeption','TASK'],['Backend API entwickeln',5,'Umsetzung','TASK'],['Frontend Dashboard bauen',5,'Umsetzung','TASK'],['Gantt Integration',3,'Umsetzung','TASK'],['Ressourcenplanung',2,'Planung','TASK'],['Testing & Bugfixing',4,'Qualität','TASK'],['Go-Live Vorbereitung',2,'Deployment','MILESTONE']
    ];
    for (const [name,duration,phase,type] of demo) await prisma.task.create({ data:{ name,duration,phase,type } });
    const tasks = await prisma.task.findMany({ orderBy:{id:'asc'} });
    for (let i=1;i<tasks.length;i++) await prisma.taskDependency.create({ data:{ fromId:tasks[i-1].id, toId:tasks[i].id } });
    res.json({message:'Demo-Daten geladen'});
  } catch(e){ console.error(e); res.status(500).json({error:'Demo-Daten konnten nicht geladen werden'}); }
});
router.delete('/demo', async (req,res) => { try { await prisma.taskDependency.deleteMany(); await prisma.assignment.deleteMany(); await prisma.task.deleteMany(); res.json({message:'Daten gelöscht'}); } catch(e){ console.error(e); res.status(500).json({error:'Daten konnten nicht gelöscht werden'}); } });
router.post('/schedule', async (req,res) => { try { const tasks = await prisma.task.findMany(); const deps = await prisma.taskDependency.findMany(); const scheduled = scheduleTasks(tasks,deps); for (const t of scheduled) await prisma.task.update({ where:{id:t.id}, data:{start:t.start,end:t.end,slack:t.slack,critical:t.critical} }); res.json(scheduled); } catch(e){ console.error(e); res.status(400).json({error:e.message||'Zeitplan konnte nicht berechnet werden'}); } });
router.post('/dependency', async (req,res) => { try { const fromId=Number(req.body.fromId), toId=Number(req.body.toId); if(!fromId||!toId) return res.status(400).json({error:'Von- und Zu-Task erforderlich'}); if(fromId===toId) return res.status(400).json({error:'Ein Task kann nicht von sich selbst abhängen'}); const deps = await prisma.taskDependency.findMany(); if (createsCycle(deps, fromId, toId)) return res.status(400).json({error:'Zyklus erkannt'}); res.json(await prisma.taskDependency.upsert({ where:{fromId_toId:{fromId,toId}}, update:{}, create:{fromId,toId} })); } catch(e){ console.error(e); res.status(500).json({error:'Dependency konnte nicht erstellt werden'}); } });
router.post('/import', upload.single('file'), async (req,res) => {
  try { if(!req.file) return res.status(400).json({error:'Keine Datei hochgeladen'}); const filename = req.file.originalname.toLowerCase();
    if(filename.endsWith('.csv')) { const rows=[]; fs.createReadStream(req.file.path).pipe(csv()).on('data', r=>rows.push(r)).on('end', async()=>{ try { await importRows(rows); fs.unlinkSync(req.file.path); res.json({message:'CSV importiert', count:rows.length}); } catch(e){ console.error(e); res.status(500).json({error:'CSV Import fehlgeschlagen'}); } }); return; }
    if(filename.endsWith('.xlsx')) { const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(req.file.path); const ws = wb.worksheets[0]; const rows=[]; ws.eachRow((row,n)=>{ if(n===1) return; rows.push({ name:cell(row,1), duration:cell(row,2), dependsOn:cell(row,3) }); }); await importRows(rows); fs.unlinkSync(req.file.path); return res.json({message:'Excel importiert', count:rows.length}); }
    fs.unlinkSync(req.file.path); res.status(400).json({error:'Nur CSV oder XLSX erlaubt'});
  } catch(e){ console.error(e); res.status(500).json({error:'Import fehlgeschlagen'}); }
});
router.get('/export/csv', async (req,res) => { const tasks=await prisma.task.findMany({ include:{dependencies:{include:{from:true}}} }); const header='name,duration,start,end,status,type,phase,critical,dependsOn\n'; const rows=tasks.map(t=>[safe(t.name),t.duration,t.start??'',t.end??'',t.status,t.type,safe(t.phase),t.critical?'true':'false',safe(t.dependencies.map(d=>d.from.name).join('|'))].join(',')).join('\n'); res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename=smenso-export.csv'); res.send(header+rows); });
router.get('/export/excel', async (req,res) => { const tasks=await prisma.task.findMany({ include:{dependencies:{include:{from:true}}} }); const wb=new ExcelJS.Workbook(); const ws=wb.addWorksheet('Tasks'); ws.columns=[{header:'Name',key:'name',width:30},{header:'Duration',key:'duration',width:12},{header:'Start',key:'start',width:12},{header:'End',key:'end',width:12},{header:'Status',key:'status',width:16},{header:'Type',key:'type',width:14},{header:'Phase',key:'phase',width:20},{header:'Critical',key:'critical',width:12},{header:'DependsOn',key:'dependsOn',width:40}]; tasks.forEach(t=>ws.addRow({name:t.name,duration:t.duration,start:t.start??'',end:t.end??'',status:t.status,type:t.type,phase:t.phase,critical:t.critical?'true':'false',dependsOn:t.dependencies.map(d=>d.from.name).join(', ')})); res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition','attachment; filename=smenso-export.xlsx'); await wb.xlsx.write(res); res.end(); });
router.get('/export/pdf', async (req,res)=>{ const tasks=await prisma.task.findMany({orderBy:{start:'asc'}}); const doc=new PDFDocument({margin:40}); res.setHeader('Content-Type','application/pdf'); res.setHeader('Content-Disposition','attachment; filename=smenso-report.pdf'); doc.pipe(res); doc.fontSize(22).text('Smenso Projektübersicht'); doc.moveDown(); tasks.forEach(t=>doc.fontSize(12).text(`${t.name} | Dauer: ${t.duration} Tage | Start: ${t.start ?? '-'} | Ende: ${t.end ?? '-'} | Status: ${t.status} | Kritisch: ${t.critical ? 'Ja' : 'Nein'}`)); doc.end(); });
router.put('/:id', async (req,res)=>{ try{ res.json(await prisma.task.update({ where:{id:Number(req.params.id)}, data:req.body })); } catch(e){ console.error(e); res.status(500).json({error:'Task konnte nicht aktualisiert werden'}); } });
router.delete('/:id', async (req,res)=>{ try{ await prisma.task.delete({ where:{id:Number(req.params.id)} }); res.json({message:'Task gelöscht'}); } catch(e){ console.error(e); res.status(500).json({error:'Task konnte nicht gelöscht werden'}); } });

function cell(row, i){ const v=row.getCell(i).value; return v && typeof v === 'object' && 'text' in v ? v.text : v; }
async function importRows(rows){ const created={}; for (const row of rows) { const name=String(row.name??'').trim(); if(!name) continue; const task=await prisma.task.create({ data:{name, duration:Number(row.duration||1)} }); created[name]=task; } for (const row of rows){ const name=String(row.name??'').trim(); const deps=String(row.dependsOn??'').trim(); if(!name||!deps) continue; const toTask=created[name]; for(const depName of deps.split(/[,|]/).map(v=>v.trim()).filter(Boolean)){ const fromTask=created[depName]; if(fromTask&&toTask&&fromTask.id!==toTask.id) await prisma.taskDependency.upsert({ where:{fromId_toId:{fromId:fromTask.id,toId:toTask.id}}, update:{}, create:{fromId:fromTask.id,toId:toTask.id} }); } } }
function safe(v){ return `"${String(v??'').replace(/"/g,'""')}"`; }
function createsCycle(existing, fromId, toId){ const graph={}; for(const d of existing){ (graph[d.fromId] ||= []).push(d.toId); } (graph[fromId] ||= []).push(toId); const visited=new Set(), stack=new Set(); function dfs(n){ if(stack.has(n)) return true; if(visited.has(n)) return false; visited.add(n); stack.add(n); for(const next of graph[n]||[]) if(dfs(next)) return true; stack.delete(n); return false; } return Object.keys(graph).some(n=>dfs(Number(n))); }
module.exports = router;
