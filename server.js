const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { items } = require("./catalog.json");
const sections = [...new Set(items.map(x => x.section))].map((name,i)=>({id:"mxcat_"+i,name}));
const manifest = {
 id:"org.cinemexicano.videoteca500", version:"2.0.0",
 name:"La gran videoteca del cine mexicano 🇲🇽",
 description:"500 títulos organizados por época y figuras. Catálogo informativo; no contiene enlaces de reproducción.",
 resources:["catalog","meta"], types:["movie"], idPrefixes:["mx:"],
 catalogs:sections.map(s=>({type:"movie",id:s.id,name:s.name}))
};
const builder = new addonBuilder(manifest);
builder.defineCatalogHandler(({type,id,extra})=>{
 if(type!=="movie") return Promise.resolve({metas:[]});
 const section=sections.find(s=>s.id===id); if(!section) return Promise.resolve({metas:[]});
 let rows=items.filter(x=>x.section===section.name);
 if(extra && extra.search){const q=String(extra.search).toLocaleLowerCase("es");rows=rows.filter(x=>x.name.toLocaleLowerCase("es").includes(q));}
 const seen=new Set();
 const metas=rows.filter(x=>!seen.has(x.id)&&seen.add(x.id)).map(x=>({
  id:x.id,type:"movie",name:x.name,releaseInfo:String(x.year),description:section.name+" · "+x.year
 }));
 return Promise.resolve({metas});
});
builder.defineMetaHandler(({type,id})=>{
 const x=items.find(y=>y.id===id);
 if(type!=="movie"||!x)return Promise.resolve({meta:null});
 return Promise.resolve({meta:{id:x.id,type:"movie",name:x.name,releaseInfo:String(x.year),description:x.section+" · "+x.year}});
});
serveHTTP(builder.getInterface(),{port:process.env.PORT||7000});
