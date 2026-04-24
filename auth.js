const router = require('express').Router();
const prisma = require('../prisma');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const SECRET = 'dev-secret';
router.post('/register', async (req,res)=>{ try{ const {email,password}=req.body; if(!email||!password) return res.status(400).json({error:'E-Mail und Passwort erforderlich'}); const hash=await bcrypt.hash(password,10); const user=await prisma.user.create({data:{email,password:hash}}); const token=jwt.sign({userId:user.id,email:user.email},SECRET,{expiresIn:'7d'}); res.json({token,user:{id:user.id,email:user.email}}); } catch(e){ console.error(e); res.status(500).json({error:'Registrierung fehlgeschlagen'}); } });
router.post('/login', async (req,res)=>{ try{ const {email,password}=req.body; if(!email) return res.status(400).json({error:'E-Mail erforderlich'}); let user=await prisma.user.findUnique({where:{email}}); if(!user){ const hash=await bcrypt.hash(password||'demo',10); user=await prisma.user.create({data:{email,password:hash}}); } else if(password) { const ok=await bcrypt.compare(password,user.password); if(!ok) return res.status(400).json({error:'Passwort falsch'}); } const token=jwt.sign({userId:user.id,email:user.email},SECRET,{expiresIn:'7d'}); res.json({token,user:{id:user.id,email:user.email}}); } catch(e){ console.error(e); res.status(500).json({error:'Login fehlgeschlagen'}); } });
module.exports = router;
