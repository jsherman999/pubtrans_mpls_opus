const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const source=readFileSync(new URL('../index.html',`file://${__filename}`),'utf8').split('<script>')[1].split('</script>')[0];
function boot(seed) {
 const math=Object.create(Math);
 if(seed!=null)math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const elements=new Map();
 const context=new Proxy({}, {get:(o,k)=>k==='measureText'?()=>({width:40}):k==='createLinearGradient'?()=>({addColorStop(){}}):()=>{}});
 function el(){return {width:780,height:780,style:{},dataset:{},classList:{add(){},toggle(){}},setAttribute(){},append(){},appendChild(){},removeChild(){},addEventListener(t,f){this[t]=f;},getContext(){return context},getBoundingClientRect(){return {top:0,bottom:780,width:780,height:780,left:0}},value:'',textContent:'',innerHTML:'',children:[],scrollHeight:0};}
 const doc={getElementById(id){if(!elements.has(id)) elements.set(id,el());return elements.get(id)},querySelector(id){return this.getElementById(id)},createElement:el};
 const sandbox={document:doc,window:{innerHeight:900,performance:{},addEventListener(){}},navigator:{hardwareConcurrency:4},performance:{now:()=>0},setInterval(){},setTimeout(){},console,Math:math};
 vm.createContext(sandbox);vm.runInContext(source,sandbox);
 return {run:s=>vm.runInContext(s,sandbox),elements};
}
// Every map and the sidebar control the same pause state, in both modes.
{
 const {run,elements}=boot(42);
 assert.equal(run('simulationPauseButtons.length'),8);
 run('render=()=>{};renderCockpit=()=>{};renderMetricsGraph=()=>{};');
 for(let button=0;button<8;button++) {
   run(`simulationPauseButtons[${button}].click()`);
   assert.equal(run('paused && simulationPauseButtons.every(b=>b.textContent==="Resume")'),true);
   const before=run('JSON.stringify([simElapsed,cars,trains,queue])');
   run('tick();tick();');
   assert.equal(run('JSON.stringify([simElapsed,cars,trains,queue])'),before);
   run(`simulationPauseButtons[${(button+1)%8}].click()`);
   assert.equal(run('!paused && simulationPauseButtons.every(b=>b.textContent==="Pause")'),true);
   const elapsed=run('simElapsed');
   run('tick()');
   assert.ok(run('simElapsed')>elapsed);
 }
 run('setMode("interactive");ix.drivingCar=cars[0];ix.drivingCar.state="driving";stepCars=()=>{};');
 const elapsed=run('simElapsed');
 run('simulationPauseButtons[2].click();tick();');
 assert.equal(run('simElapsed'),elapsed);
 elements.get('pause').click();
 run('tick()');
 assert.ok(run('simElapsed')>elapsed);
 run('setSimulationPaused(true);setMode("auto");');
 assert.equal(run('!paused && simulationPauseButtons.every(b=>b.textContent==="Pause")'),true);
}
console.log('PASS: all seven map pause buttons and sidebar stay synchronized; auto and interactive simulation pause and resume.');

for(let trial=0;trial<12;trial++) {
 const {run,elements}=boot();
 assert.equal(run('GRID_N-1'),6);
 assert.equal(run('developments.every(d=>d.homes.length===24 && d.gapMeters>=0 && d.gapMeters<=1609)'),true);
 assert.equal(run('BUILDINGS.every(b=>dijkstra(CENTRAL_NODE,b.accessId) && dijkstra(b.accessId,CENTRAL_NODE))'),true);
 assert.equal(run('Object.values(edges).every(e=>Number.isFinite(e.length)&&e.length>0)'),true);
 run('render=()=>{};renderCockpit=()=>{};renderMetricsGraph=()=>{};dbg=()=>{};speedMult=20;');
 run(`for(let t=0;t<400;t++){ tick(); for(const c of cars){
   if(!Number.isFinite(c.pos.x)||!Number.isFinite(c.pos.y))throw Error('invalid position');
   if(c.riders.length>c.capacity)throw Error('capacity exceeded');
   if(c.route && c.routeIndex<c.route.edges.length){
    const a=nodeXY(c.route.nodes[c.routeIndex]),b=nodeXY(c.route.nodes[c.routeIndex+1]);
    const cross=(c.pos.x-a[0])*(b[1]-a[1])-(c.pos.y-a[1])*(b[0]-a[0]);
    if(Math.abs(cross)>1e-5)throw Error('vehicle off roadway');
   }
 }}`);
 assert.ok(run('completedTrips.length')>0);
 assert.equal(run('eventSchedule.filter(e=>e.pickup==="Central Stn" && e.minute<=simMinute).every(e=>e.fired)'),true);
 elements.get('reset').click();
 assert.equal(run('eventSchedule.some(e=>e.fired)'),false);
 assert.equal(run('completedTrips.length'),0);
 // Every neighborhood supports a local interactive trip and a cross-region trip.
 run(`for(const d of developments){ const routes=kShortest(d.homes[0].accessId,d.homes[19].accessId);if(!routes.length)throw Error('local route missing'); }
 if(!kShortest(developments[0].homes[0].accessId,developments[3].homes[19].accessId).length)throw Error('regional route missing');`);
}
console.log('PASS: 12 randomized worlds, 120 suburban homes, directed connectivity, local/cross-region routes, capacity, road-only vehicle positions, completed rides, train events and reset.');

// Rendering must follow CSS size × DPR without changing logical coordinates,
// reallocating unchanged buffers, or scaling a low-resolution cockpit image.
{
 const {run}=boot();
 run(`
   const probe={_width:0,_height:0,writes:0,transform:[],
     get width(){return this._width},set width(v){this._width=v;this.writes++},
     get height(){return this._height},set height(v){this._height=v;this.writes++},
     getContext(){return {setTransform:(...args)=>this.transform=args}}};
   for(const [width,height,dpr] of [[1900,1900,2],[350,350,3],[1024.5,1024.5,1.25],[640,480,1]]) {
     window.devicePixelRatio=dpr;
     sizeDrawingSurface(probe,780,780,{width,height});
     if(probe.width!==Math.round(width*dpr)||probe.height!==Math.round(height*dpr)) throw Error('wrong pixel resolution');
     if(probe.transform[0]!==probe.width/780||probe.transform[3]!==probe.height/780) throw Error('wrong logical transform');
     const writes=probe.writes;
     sizeDrawingSurface(probe,780,780,{width,height});
     if(probe.writes!==writes) throw Error('unnecessary buffer allocation');
   }
   window.devicePixelRatio=3;
   renderCockpit();
   if(fpvCanvas.width!==cockpitCanvas.width || fpvCanvas.height!==cockpitCanvas.height) throw Error('cockpit upsampled');
   if(FPV_W!==640 || FPV_H!==640) throw Error('projection coordinates changed');
   // Pointer selection remains in logical coordinates at the new resolution.
   mode='interactive';
   const centerView=mapViews.find(v=>v.id==='center');
   const building=BUILDINGS[0], point=buildingCenter(building);
   handleMapClick({clientX:point[0]*centerView.scale+centerView.tx,
     clientY:point[1]*centerView.scale+centerView.ty},centerView);
   if(ix.source!==building) throw Error('high-DPI picking broken');
 `);
}
console.log('PASS: Retina/phone/fractional DPR sizing, unchanged-buffer reuse, native cockpit rendering and map picking.');

{
 const {run,elements}=boot();
 assert.equal(run('countCars("bus")'),5);
 assert.equal(run('developments.every((_,i)=>cars.filter(c=>c.kind==="bus"&&c.development===i&&c.capacity===20&&c.color===COLORS.bus).length===1)'),true);
 run(`
   humans.length=0; queue.length=0;
   cars.splice(0,cars.length,...cars.filter(c=>c.kind==='bus'));
   const home=developments[0].homes[0],school=buildingByName('Hillside');
   function request(from,to){return {id:nextReqId++,human:{id:-1},from,to,pickupId:from.accessId,dropoffId:to.accessId,requestedAt:simMinute};}
   for(let i=0;i<25;i++) queue.push(request(home,school));
   queue.push(request(school,home));
   queue.push(request(developments[1].homes[0],developments[1].homes[2]));
   queue.push(request(developments[1].homes[0],developments[2].homes[0]));
   dispatch();
   const serviceBus=cars.find(c=>c.development===0);
   if(serviceBus.pickupQueue.length!==20) throw Error('bus must pool 20 passengers');
   if(cars.filter(c=>c.state!=='idle').length!==1) throw Error('wrong neighborhood bus dispatched');
   if(queue.length!==8) throw Error('opposite direction/local/cross-region demand should remain queued');
   for(let t=0;t<2000 && serviceBus.state!=='idle';t++) {stepCars(20);tickStoplights();
     if(serviceBus.riders.length>20) throw Error('bus over capacity');
   }
   if(completedTrips.length!==20) throw Error('bus did not complete full load');
   queue.splice(0,queue.length,...queue.filter(r=>r.from===school));
   dispatch();
   if(serviceBus.pickupQueue.length!==1 || serviceBus.pickupQueue[0].to!==home) throw Error('outbound service missing');
   addCars('bus',1);
   if(cars.filter(c=>c.kind==='bus'&&c.development===0).length!==2) throw Error('extra bus not balanced');
   removeCars('bus',1);
   if(countCars('bus')!==5) throw Error('bus control count wrong');
   // Request retirement of the busy bus after removing other neighborhoods.
   for(const c of cars) if(c!==serviceBus)c.retiring=true;
   retireFinishedBuses();
   removeCars('bus',1);
   if(!serviceBus.retiring || !cars.includes(serviceBus)) throw Error('busy bus must finish service');
   if(countCars('bus')!==0) throw Error('retiring bus should not count as available');
   for(let t=0;t<2000 && cars.includes(serviceBus);t++){stepCars(20);tickStoplights();retireFinishedBuses();}
   if(completedTrips.length!==21 || cars.includes(serviceBus)) throw Error('retirement lost rider or failed');
   if(Object.values(edges).some(e=>e.claims.has(serviceBus.id))) throw Error('retired bus left road claims');
   addCars('bus',5);
   if(!developments.every((_,i)=>cars.filter(c=>c.kind==='bus'&&c.development===i).length===1)) throw Error('restored fleet must serve all neighborhoods');
 `);
 elements.get('sim-controls').click({target:{dataset:{act:'bus-inc'}}});
 assert.equal(run('countCars("bus")'),6);
 elements.get('sim-controls').click({target:{dataset:{act:'bus-dec'}}});
 assert.equal(run('countCars("bus")'),5);
 elements.get('reset').click();
 assert.equal(run('cars.filter(c=>c.kind==="bus").every(c=>c.capacity===20&&c.state==="idle")'),true);
}
console.log('PASS: five assigned buses, 20-rider pooling, inbound/outbound service, neighborhood restrictions, balanced fleet controls, safe retirement and reset.');

{
 const {run}=boot();
 run(`
   dbg=()=>{};humans.length=0;queue.length=0;
   const sharingBus=cars.find(c=>c.kind==='bus'&&c.development===0);
   const home=developments[0].homes[0],hub=buildingByName('Central Stn');
   const original={id:nextReqId++,human:{id:-1},from:hub,to:home,pickupId:hub.accessId,dropoffId:home.accessId,requestedAt:simMinute};
   assignMultiStop(sharingBus,[original],'TEST');
   // Complete boarding, then sample an exact mid-edge position.
   for(let i=0;i<100 && sharingBus.state!=='enroute_dropoff';i++)stepCars(1,sharingBus);
   stepCars(1,sharingBus);
   const before={...sharingBus.pos};
   const back={id:nextReqId++,human:{id:-1},from:home,to:hub,pickupId:home.accessId,dropoffId:hub.accessId,requestedAt:simMinute};
   queue.push(back);
   rideSharing=0;
   if(tryShareRide(sharingBus)) throw Error('baseline sharing must be off');
   rideSharing=100;
   if(!tryShareRide(sharingBus)) throw Error('return rider should be admitted while delivering outbound rider');
   if(Math.hypot(sharingBus.pos.x-before.x,sharingBus.pos.y-before.y)>1e-8) throw Error('sharing teleported vehicle');
   if(queue.length || !sharingBus.pickupQueue.includes(back)) throw Error('request ownership incorrect');
   if(!sharingCapacity(sharingBus,[sharingBus._activeSeg,...sharingBus._segments])) throw Error('capacity invalid');
   for(let t=0;t<3000 && sharingBus.state!=='idle';t++){stepCars(20,sharingBus);tickStoplights();}
   if(completedTrips.length!==2 || sharingBus.nodeId!==CENTRAL_NODE) throw Error('original and return riders must arrive at correct stops');
   if(sharingBus.pickupQueue.length || sharingBus.riders.length) throw Error('sharing left passengers behind');
   // An empty returning shuttle can also collect along its current road.
   const shuttle=cars.find(c=>c.kind==='shuttle');
   shuttle.nodeId=home.accessId;shuttle.pos={x:nodeXY(home.accessId)[0],y:nodeXY(home.accessId)[1]};
   setRoute(shuttle,dijkstra(shuttle.nodeId,CENTRAL_NODE));shuttle.state='returning';
   const next=shuttle.route.nodes[1];
   const curb={name:'Roadside test stop',accessId:next,development:0};
   const ride={...back,id:nextReqId++,from:curb,pickupId:next,pickedUpAt:undefined,completedAt:undefined};queue.push(ride);
   if(!tryShareRide(shuttle)) throw Error('returning shuttle ignored on-route pickup');
   for(let t=0;t<3000 && shuttle.state!=='idle';t++){stepCars(20,shuttle);tickStoplights();}
   if(completedTrips.length!==3) throw Error('shuttle rider not delivered');
   if(Object.values(edges).some(e=>e.claims.has(shuttle.id))) throw Error('sharing left stale claims');
   // Promised pickups consume capacity, not just people already aboard.
   const fullStops=[{type:'pickup',reqs:Array.from({length:9},()=>({}))},{type:'dropoff',reqs:Array.from({length:9},()=>({}))}];
   if(sharingCapacity(shuttle,fullStops)) throw Error('overbooked shuttle');
   sharingBus.retiring=true;queue.push({...back,id:nextReqId++});
   if(tryShareRide(sharingBus)) throw Error('retiring bus accepted rider');
   sharingBus.retiring=false;
   if(busDirection(sharingBus,{from:developments[1].homes[0],to:hub}))throw Error('wrong neighborhood allowed');
 `);
}
console.log('PASS: baseline off, mid-edge continuity, outbound-to-return insertion, returning shuttle pickup, promised capacity, rider delivery and claim cleanup.');
{
 const {run}=boot();
 run(`
   render=()=>{};renderCockpit=()=>{};renderMetricsGraph=()=>{};dbg=()=>{};
   addHumans(400);rideSharing=100;speedMult=20;
   for(let t=0;t<160;t++) {
     tick();
     const assigned=new Set();
     for(const car of cars){
       if(car.riders.length>car.capacity)throw Error('over capacity in busy shared simulation');
       for(const r of [...car.pickupQueue,...car.riders]) {
         if(assigned.has(r.id))throw Error('duplicate assignment');assigned.add(r.id);
       }
       if(car.route && car.routeIndex<car.route.edges.length){
         const a=nodeXY(car.route.nodes[car.routeIndex]),b=nodeXY(car.route.nodes[car.routeIndex+1]);
         const cross=(car.pos.x-a[0])*(b[1]-a[1])-(car.pos.y-a[1])*(b[0]-a[0]);
         if(Math.abs(cross)>1e-5)throw Error('shared car off road');
       }
     }
     if(queue.some(r=>assigned.has(r.id)))throw Error('queued rider also assigned');
   }
   if(!sharedPickups || !completedTrips.length)throw Error('sharing never ran');
 `);
}
console.log('PASS: maximum-population shared simulation, road continuity, capacity, exclusive request ownership and completed rides.');
{
 const {run}=boot();
 assert.equal(run('developments.length'),5);
 assert.equal(run('developments[4].gapMeters'),0);
 assert.ok(run('nodeDist(developments[4].gate,developments[4].entry)')<=run('CELL'));
 assert.equal(run('developments.every(d=>d.culDeSacs.length===4 && d.culDeSacs.every(n=>d.homes.filter(b=>b.accessId===n).length===2))'),true);
 run(`
   const bus=cars.find(c=>c.kind==='bus');
   const from=developments[0].homes[0],to=buildingByName('Hillside');
   const group=Array.from({length:5},()=>({id:nextReqId++,human:{id:-1},from,to,pickupId:from.accessId,dropoffId:to.accessId,requestedAt:simMinute}));
   assignMultiStop(bus,group,'TRANSFER TEST');
   for(let t=0;t<3000 && bus.state!=='idle';t++){stepCars(20,bus);tickStoplights();}
   if(completedTrips.length!==5)throw Error('transfer trip not completed');
   if(passengerTransfers.filter(e=>e.boarding).length!==5 || passengerTransfers.filter(e=>!e.boarding).length!==5)throw Error('expected exactly one animation per passenger in each direction');
   for(const effect of passengerTransfers) {
     effect.finished=false;
     if(!transferPosition(effect,effect.start+effect.duration/2) || transferPosition(effect,effect.start-1) || transferPosition(effect,effect.start+effect.duration+1))throw Error('transfer lifetime incorrect');
   }
   passengerTransfers.length=0;
   for(const b of buildingsByType.residential.filter(b=>b.development!=null)) drawRanchFPV(b,{x:b.x,y:b.y-40,cos:1,sin:0});
 `);
}
console.log('PASS: fifth connected neighborhood within one block, two homes at every cul-de-sac, ranch rendering and exact per-person transfer effects.');
{
 const {run,elements}=boot();
 assert.equal(run('humans.length'),450);
 assert.equal(run('countCars("sedan")'),15);
 assert.equal(run('countCars("shuttle")'),14);
 assert.equal(run('countCars("bus")'),5);
 assert.equal(run('rideSharing'),100);
 assert.equal(run('buildingsByType.school.length'),1);
 assert.equal(run('buildingByName("Riverbend Apts").units'),100);
 assert.equal(run('buildingsByType.residential.includes(buildingByName("Riverbend Apts"))'),true);
 assert.equal(run('eventSchedule.every(e=>[e.pickup,e.dropoff].every(n=>n==="residential" || buildingByName(n)))'),true);
 assert.equal(elements.get('ctl-pop').textContent,450);
 assert.equal(elements.get('ctl-sed').textContent,15);
}
console.log('PASS: startup defaults and residential apartment/school event configuration.');
// Downtown housing units weight home assignment, and the 450-person default
// keeps the earlier residents-per-home ratio.
{
 const {run}=boot(7);
 const units={"Riverbend Apts":100,"Maple Row":8,"Cedar Block":24,"Birch Hgts":40,"Oak Hgts":40};
 assert.deepEqual(JSON.parse(run('JSON.stringify(Object.fromEntries(buildingsByType.residential.filter(b=>b.units).map(b=>[b.name,b.units])))')),units);
 assert.equal(run('buildingsByType.residential.reduce((sum,b)=>sum+(b.units || 1),0)'),332);
 assert.equal(run('POPULATION'),450);
 assert.equal(run('POP_MAX'),800);
 const shares=JSON.parse(run(`(()=>{const n=20000,counts={};
   for(let i=0;i<n;i++){const b=pickResidential(),key=b.units?b.name:"suburb";counts[key]=(counts[key]||0)+1;}
   for(const key in counts)counts[key]/=n;return JSON.stringify(counts);})()`));
 for(const [name,count] of Object.entries({...units,suburb:120}))
   assert.ok(Math.abs(shares[name]-count/332)<.015,name+' share '+shares[name]);
}
console.log('PASS: 212 downtown units in five buildings, unit-weighted home assignment and the 450-person default.');

// Every downtown building has a design that stays inside its block, keeps
// standing parts separable for painter's ordering, clears the rail corridor
// and has finite geometry. Driver POV and the maps render it from every
// intersection.
{
 const {run}=boot(3);
 assert.equal(run('BUILDINGS.filter(b=>b.development==null && b!==parkRide).every(b=>buildingDesigns.has(b))'),true);
 assert.equal(run('buildingDesigns.size'),15);
 run(`for(const [b,d] of buildingDesigns){
   const standing=d.parts.filter(p=>!p.ground);
   if(b!==parkRide)for(const p of d.parts)if(p.lo[0]<-44||p.lo[1]<-44||p.hi[0]>44||p.hi[1]>44)throw Error(b.name+' leaves its block');
   for(let i=0;i<standing.length;i++)for(let j=i+1;j<standing.length;j++){
     const a=standing[i],c=standing[j];
     if(![0,1,2].some(k=>a.hi[k]<=c.lo[k]+1e-6||c.hi[k]<=a.lo[k]+1e-6))throw Error(b.name+' has interpenetrating parts');
   }
   for(const p of d.parts)for(const f of p.faces)
     for(const q of [...f.pts,...f.deco.flatMap(x=>x.polys.flat()),...f.signs.flatMap(s=>[s.a,s.b,s.c])])
       if(!q.every(Number.isFinite))throw Error(b.name+' has non-finite geometry');
   if(b.name==="Central Stn"||b===parkRide)continue;
   const [cx,cy]=buildingCenter(b);
   for(let s=0;s<railLength;s+=2){const r=railPoint(s);
     for(const p of standing){const dx=Math.max(cx+p.lo[0]-r.x,0,r.x-cx-p.hi[0]),dy=Math.max(cy+p.lo[1]-r.y,0,r.y-cy-p.hi[1]);
       if(Math.hypot(dx,dy)<20)throw Error(b.name+' intrudes on the rail corridor');}}
 }
 const box=(lo,hi)=>({lo,hi,ground:false});
 const podium=box([-44,-44,0],[44,44,28]),tower=box([-30,-30,28],[30,30,100]);
 if(orderDesignParts([podium,tower],[0,120,14])[0]!==tower)throw Error('tower must paint before its podium from the street');
 if(orderDesignParts([podium,tower],[0,120,200])[0]!==podium)throw Error('podium must paint first from above');
 const west=box([-44,0,0],[-10,40,30]),east=box([-10,0,0],[44,40,30]);
 if(orderDesignParts([east,west],[-100,20,14]).at(-1)!==west)throw Error('nearer west part must paint last');
 if(orderDesignParts([west,east],[100,20,14]).at(-1)!==east)throw Error('nearer east part must paint last');
 const original=drawDesignFPV;let drawn=0;
 drawDesignFPV=(...args)=>{drawn++;return original(...args);};
 for(let r=0;r<GRID_N;r++)for(let c=0;c<GRID_N;c++)for(let h=0;h<4;h++){
   const [x,y]=nodeXY(nodeId(c,r)),heading=h*Math.PI/2;
   renderFPV({...cars[0],pos:{x,y},heading,_displayHeading:heading});
 }
 if(!drawn)throw Error('no downtown design rendered');
 render();
 `);
}
console.log('PASS: fourteen downtown designs inside their blocks, separable parts, rail clearance, finite geometry, painter ordering and rendering.');

// Juniper Park & Ride follows its straight track. Standing parts stay clear of
// both tracks and the access road, coaches at the platforms can be ordered
// against every station part, and Driver POV draws those coaches with it.
{
 const {run}=boot(5);
 run(`const d=buildingDesigns.get(parkRide),[ox,oy]=buildingCenter(parkRide);
   const seg=railSegments.find(s=>Math.hypot(s.b[0]-ox,s.b[1]-oy)<1e-6);
   if(Math.abs(d.angle-Math.atan2(seg.b[1]-seg.a[1],seg.b[0]-seg.a[0]))>1e-9)throw Error('Park & Ride not aligned with its track');
   const standing=d.parts.filter(p=>!p.ground),local=([x,y])=>[(x-ox)*d.rc+(y-oy)*d.rs,-(x-ox)*d.rs+(y-oy)*d.rc];
   for(const p of standing)if(p.lo[1]<21&&p.hi[1]>-21)throw Error('Park & Ride part on the tracks');
   for(const {to} of adj[parkRide.accessId]) {
     const a=local(nodeXY(parkRide.accessId)),b=local(nodeXY(to));
     for(let t=0;t<=1;t+=.05){const q=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
       for(const p of standing){const dx=Math.max(p.lo[0]-q[0],0,q[0]-p.hi[0]),dy=Math.max(p.lo[1]-q[1],0,q[1]-p.hi[1]);
         if(Math.hypot(dx,dy)<FPV_ROAD_HALF)throw Error('Park & Ride part on the access road');}}
   }
   for(const u of [-100,-50,0,50,100])for(const v of [-12,12])for(const h of [0,Math.PI]){
     const coach=coachPart(u,v,h);
     for(const p of standing)if(![0,1,2].some(k=>coach.hi[k]<=p.lo[k]+1e-6||p.hi[k]<=coach.lo[k]+1e-6))throw Error('coach intersects a Park & Ride part');
   }
   trains.push({id:'t1',distance:parkRailDistance,direction:1,state:'dwelling',riders:[],dwellUntil:1e9},
     {id:'t2',distance:parkRailDistance,direction:-1,state:'dwelling',riders:[],dwellUntil:1e9});
   const original=drawDesignFPV;let claimed=0;
   drawDesignFPV=(b,design,cam,dist,coaches=[])=>{if(b===parkRide)claimed+=coaches.length;return original(b,design,cam,dist,coaches);};
   const [x,y]=nodeXY(parkRide.accessId);
   renderFPV({...cars[0],pos:{x,y},heading:d.angle,_displayHeading:d.angle});
   if(claimed<4)throw Error('platform coaches should draw with the Park & Ride, got '+claimed);
   render();`);
}
console.log('PASS: track-aligned Park & Ride clear of both tracks and its access road, with platform coaches in its painter order.');

// The live graph plots only the current queue wait and queued requests. The
// debug stream pops out from its own panel, map shortcuts cover the region,
// center and controls, and the guide opens with the pause and POV tip.
{
 const {run,elements}=boot(4);
 run('render=()=>{};renderCockpit=()=>{};dbg=()=>{};speedMult=20;for(let i=0;i<30;i++)tick();');
 assert.equal(run('GRAPH_SERIES.map(s=>s.f).join()'),'w,q');
 assert.equal(run('Object.keys(metricsHist.at(-1)).sort().join()'),'q,w');
 assert.equal(run('metricsHist.at(-1).q'),run('queue.length'));
 assert.equal(run('metricsHist.at(-1).w'),run('currentQueueWaitMinutes()'));
 run(`queue.length=0;for(const car of cars)car.pickupQueue=[];
   queue.push({requestedAt:simElapsed-3},{requestedAt:simElapsed-5});
   cars[0].pickupQueue.push({requestedAt:simElapsed-7},{requestedAt:simElapsed-9,pickedUpAt:simElapsed-1});`);
 assert.equal(run('currentQueueWaitMinutes()'),5);
 assert.equal(elements.get('dbg-pop-inline').click,run('openDebugWindow'));
 const html=readFileSync(new URL('../index.html',`file://${__filename}`),'utf8');
 const nav=html.match(/<nav class="map-nav"[^>]*>(.*?)<\/nav>/)[1];
 assert.deepEqual([...nav.matchAll(/href="#([^"]+)"/g)].map(m=>m[1]),['region-card','center-card','controls']);
 const guide=html.slice(html.indexOf('<div class="guide-body">'));
 assert.ok(guide.indexOf('Press Pause')>=0 && guide.indexOf('Press Pause')<guide.indexOf('<h3>'));
}
console.log('PASS: queue-wait/queued live graph, debug pop-out button, trimmed map shortcuts and guide pause tip.');

// Driver POV rides the Juniper Commons bus all day. Tapped cars override it,
// and it changes bus only when the followed one leaves the fleet.
{
 const {run,elements}=boot(9);
 run('render=()=>{};renderMetricsGraph=()=>{};dbg=()=>{};speedMult=20;tick();');
 const bus=run('cockpitCar.id');
 assert.equal(run('cockpitCar.kind'),'bus');
 assert.equal(run('developments[cockpitCar.development].name'),'Juniper Commons');
 assert.match(elements.get('cockpit-car').textContent,/following/);
 run('for(let i=0;i<150;i++)tick();');
 assert.equal(run('cockpitCar.id'),bus);
 run('startSpectate(cars.find(c=>c.kind==="sedan"));tick();');
 assert.equal(run('cockpitCar.kind'),'sedan');
 run('stopSpectate();tick();');
 assert.equal(run('cockpitCar.id'),bus);
 // Switching vehicles while paused keeps the simulation paused.
 run('setSimulationPaused(true);startSpectate(cars.find(c=>c.kind==="shuttle"));tick();');
 assert.equal(run('paused'),true);
 assert.equal(run('cockpitCar.kind'),'shuttle');
 run('stopSpectate();setSimulationPaused(false);tick();');
 assert.equal(run('cockpitCar.id'),bus);
 elements.get('reset').click();
 run('tick()');
 assert.equal(run('cockpitCar.id'),bus);
 run(`cars.splice(cars.findIndex(c=>c.id===${JSON.stringify(bus)}),1);tick();`);
 assert.equal(run('cockpitCar.kind'),'bus');
 assert.notEqual(run('cockpitCar.id'),bus);
}
console.log('PASS: Driver POV follows one Juniper Commons bus through ticks, spectating and reset, and moves on only when it is removed.');
{
 const {run,elements}=boot();
 run(`
   const vehicle=makeCar('shuttle','timing-test');cars.splice(0,cars.length,vehicle);
   const from=buildingByName('Central Stn'),to=buildingByName('Hillside');
   const riders=[0,1].map(i=>({id:90000+i,from,to,pickupId:from.accessId,dropoffId:to.accessId,requestedAt:0}));
   assignMultiStop(vehicle,riders,'TIMING TEST');
   arriveAtRouteEnd(vehicle);
   simElapsed=120;stepCars(1,vehicle);
   simElapsed=122;stepCars(1,vehicle);
   for(let i=0;i<3;i++)stepCars(1,vehicle); // finish visual departure pause and start dropoff segment
   simElapsed=140;vehicle.nodeId=to.accessId;arriveAtRouteEnd(vehicle);
   if(completedCount!==2 || completedRideMinutes!==38)throw Error('per-person boarding clocks incorrect');
   if(completedTrips[0].tripMin!==20 || completedTrips[1].tripMin!==18)throw Error('queue time included in ride duration');
   if(completePassenger(riders[0]))throw Error('passenger counted twice');
   updateHUD();
 `);
 assert.equal(elements.get('avg-trip').textContent,'19.0');
 run(`
   for(let i=0;i<1005;i++) {
     const request={requestedAt:simElapsed-200};boardPassenger(request);
     simElapsed+=10;completePassenger(request);
   }
   updateHUD();
   if(completedCount!==1007 || completedTrips.length!==1000)throw Error('completion counter capped with history');
   if(completedRideMinutes!==10088)throw Error('all-time ride sum incorrect');
   const midnightRider={requestedAt:simElapsed};boardPassenger(midnightRider);
   simMinute=1439;advanceSimulationTime(4);completePassenger(midnightRider);
   if(completedTrips.at(-1).tripMin!==4)throw Error('day rollover broke rider duration');
 `);
 assert.equal(elements.get('completed-rides').textContent,1007);
 elements.get('reset').click();run('updateHUD()');
 assert.equal(run('completedCount'),0);
 assert.equal(run('simElapsed'),0);
 assert.equal(elements.get('avg-trip').textContent,'—');
 assert.equal(elements.get('completed-rides').textContent,0);
}
console.log('PASS: distinct passenger boarding times, excluded queue time, 1000+ completions, bounded history, day rollover and clean metrics reset.');
{
 const {run,elements}=boot();
 assert.equal(run('averageQueueMinutes()'),null);
 run(`
   const unassigned={requestedAt:0},assigned={requestedAt:10},boarded={requestedAt:0};
   simElapsed=20;boardPassenger(boarded); // fixed 20-minute wait
   queue.push(unassigned);cars[0].pickupQueue=[assigned];
   cars[1].pickupQueue=[assigned,boarded]; // duplicate reference must not inflate count
   simElapsed=40;updateHUD();
   if(averageQueueMinutes()!==30)throw Error('expected (20 + 40 + 30) / 3');
   simElapsed=50;boardPassenger(assigned);updateHUD();
   if(averageQueueMinutes()!==110/3)throw Error('boarding must freeze assigned wait at 40');
   boardPassenger(assigned);
   if(boardedQueueCount!==2)throw Error('boarding counted twice');
   simElapsed=60;
   if(averageQueueMinutes()!==40)throw Error('only unboarded rider should continue accumulating');
   const request={requestedAt:7};cars[2].pickupQueue=[request];cars[2].state='enroute_pickup';
   // Fleet removal must preserve the original request timestamp.
   cars[2].kind='shuttle';cars.splice(3);removeCars('shuttle',1);
   if(request.requestedAt!==7)throw Error('requeue erased waiting time');
 `);
 elements.get('reset').click();run('updateHUD()');
 assert.equal(run('averageQueueMinutes()'),null);
 assert.equal(elements.get('avg-queue').textContent,'—');
}
console.log('PASS: running queue average includes assigned/unassigned riders, freezes at boarding, deduplicates, preserves request age and resets.');
// The same seeded simulation must produce identical rides at different playback
// speeds, including all boarding, signals, obstacles and shared-route decisions.
{
 const a=boot(12345),b=boot(12345);
 for(const sim of [a,b])sim.run('render=()=>{};renderCockpit=()=>{};renderMetricsGraph=()=>{};dbg=()=>{};');
 a.run('speedMult=1;for(let i=0;i<1200;i++)tick();');
 b.run('speedMult=20;for(let i=0;i<60;i++)tick();');
 const snapshot='JSON.stringify({elapsed:simElapsed,completed:completedCount,minutes:completedRideMinutes,queue:queue.map(r=>r.id),cars:cars.map(c=>[c.id,c.state,c.nodeId,c.progress,c.riders.map(r=>r.id)])})';
 assert.equal(a.run(snapshot),b.run(snapshot));
 // Verify a direct edge at each configured speed against distance/speed.
 a.run(`
   for(const kph of [20,25,35]) {
     const car=makeCar('sedan','speed-test');const key=Object.keys(edges)[0],edge=edges[key];
     edge.speedKph=kph;car.nodeId=edge.a;car.state='returning';
     setRoute(car,{nodes:[edge.a,edge.b],edges:[key],cost:edge.length});
     cars.push(car);let steps=0;
     while(car.state!=='idle' && steps<100){stepCars(1,car);steps++;}
     const expected=edge.length*100/(kph/3.6),actual=steps*SIM_MIN_PER_TICK*60;
     if(actual<expected-1e-7 || actual-expected>3.0001)throw Error('physical speed mismatch');
   }
 `);
 console.log('PASS: identical simulation at 1×/20× and distance-calibrated 20/25/35 km/h road speeds.');
}
{
 const {run}=boot();
 run(`
   const bus=makeCar('bus','boarding-visual-test',0);cars.push(bus);
   const from=buildingByName('Central Stn'),to=buildingByName('Hillside');
   const request={id:999999,requestedAt:simElapsed,from,to,pickupId:from.accessId,dropoffId:to.accessId};
   assignMultiStop(bus,[request],'VISUAL TEST');arriveAtRouteEnd(bus);stepCars(1,bus);
   const effect=passengerTransfers.find(e=>e.car===bus&&e.boarding);
   for(let i=0;i<2;i++) {
     stepCars(1,bus);
     if(bus.state!=='boarding_wait'||effect.finished)throw Error('departed before boarding visual finished');
   }
   stepCars(1,bus);
   if(bus.state!=='enroute_dropoff'||!effect.finished)throw Error('boarding effect must finish before departure');
   if(transferPosition(effect,effect.start+1)!==null)throw Error('departed bus left a boarding figure behind');
 `);
}
console.log('PASS: vehicle waits for the last boarding figure and removes it before departure.');
// Emergency dwell times use the simulation clock; closures affect one direction.
{
 const {run,elements}=boot(729);
 run(`
   dbg=()=>{};cars.length=0;
   const target=developments[0].homes[0];
   const incident=triggerEmergency('police',target),officer=incident.responders[0];
   for(let i=0;i<2000&&officer.state!=='emergency_scene';i++){simElapsed+=SIM_MIN_PER_TICK;tickStoplights();stepCars(1);}
   if(officer.state!=='emergency_scene')throw Error('police never arrived');
   const block=[...directionalBlocks.values()][0];
   if(!directionBlocked(block.from,block.to)||directionBlocked(block.to,block.from))throw Error('closure direction wrong');
   if(directionBlocked(block.from,block.to,incident.id))throw Error('responders blocked by own incident');
   simElapsed=officer.sceneUntil-.01;tickEmergencyVehicles();
   if(officer.state!=='emergency_scene'||officer.riders.length)throw Error('left before five minutes');
   simElapsed=officer.sceneUntil;tickEmergencyVehicles();
   if(officer.state!=='emergency_return'||officer.riders.length!==1||directionalBlocks.size)throw Error('police return missing');
   for(let i=0;i<2000&&cars.length;i++){simElapsed+=SIM_MIN_PER_TICK;tickStoplights();stepCars(1);tickEmergencyVehicles();}
   if(cars.length||incidents.length||completedCount!==1)throw Error('police failed to return passenger');
   const fire=triggerEmergency('fire',target);
   if(fire.responders.filter(c=>c.kind==='fire').length!==2||fire.responders.filter(c=>c.kind==='firecar').length!==2)throw Error('fire fleet incorrect');
   for(let i=0;i<2000&&!fire.responders.every(c=>c.state==='emergency_scene');i++){simElapsed+=SIM_MIN_PER_TICK;tickStoplights();stepCars(1);}
   if(!fire.responders.every(c=>c.state==='emergency_scene'))throw Error('fire vehicles never arrived');
   const firstEnd=Math.min(...fire.responders.map(c=>c.sceneUntil));
   simElapsed=firstEnd-.01;tickEmergencyVehicles();
   if(fire.responders.some(c=>c.state!=='emergency_scene'))throw Error('fire departed early');
   for(let i=0;i<3000&&cars.length;i++){simElapsed+=SIM_MIN_PER_TICK;tickStoplights();tickEmergencyVehicles();stepCars(1);}
   if(cars.length||incidents.length||directionalBlocks.size)throw Error('fire response did not clear');
 `);
 elements.get('trigger-emergency').click();
 assert.equal(run('incidents.length'),1);
 elements.get('reset').click();
 assert.equal(run('incidents.length+directionalBlocks.size+cars.filter(c=>c.incident).length'),0);
}
console.log('PASS: police pickup/return, four fire responders, timed directional closures, trigger and reset.');
{
 const {run}=boot(930);
 run(`
   dbg=()=>{};cars.length=0;
   const broken=makeCar('shuttle','broken-test');cars.push(broken);
   broken.nodeId=developments[0].homes[0].accessId;
   const riders=[developments[0].homes[2],buildingByName('Central Stn')].map((to,i)=>({id:9000+i,requestedAt:0,pickedUpAt:1,from:developments[0].homes[0],to,pickupId:broken.nodeId,dropoffId:to.accessId}));
   broken.riders=riders.slice();simElapsed=2;
   const rescue=stallVehicle(broken);
   if(!rescue||rescue.rescueTarget!==broken||broken.state!=='vehicle_trouble')throw Error('recovery not dispatched');
   for(let i=0;i<2000&&rescue.rescueTarget;i++){simElapsed+=SIM_MIN_PER_TICK;tickStoplights();stepCars(1);tickEmergencyVehicles();}
   if(broken.riders.length||rescue.riders.length!==2||broken.state!=='trouble_repair')throw Error('transfer missing');
   if(riders.some(r=>r.pickedUpAt!==1)||boardedQueueCount)throw Error('transfer reset passenger timing');
   for(let i=0;i<4000&&riders.some(r=>r.completedAt==null);i++){simElapsed+=SIM_MIN_PER_TICK;tickStoplights();tickEmergencyVehicles();stepCars(1);}
   if(riders.some(r=>r.completedAt==null)||completedCount!==2)throw Error('recovery failed delivery');
   if(Math.abs(completedRideMinutes-riders.reduce((s,r)=>s+r.completedAt-1,0))>1e-7)throw Error('wrong recovered ride time');
 `);
}
console.log('PASS: immediate occupied-vehicle recovery, all destinations delivered and original pickup times preserved.');
{
 const {run}=boot(321);
 run(`
   dbg=()=>{};cars.length=0;
   const rescue=makeCar('recovery','retry-test');cars.push(rescue);
   const to=developments[0].homes[0];
   const request={id:9876,requestedAt:0,pickedUpAt:1,to,dropoffId:to.accessId};
   rescue.riders=[request];simElapsed=2;
   for(const e of Object.values(edges)) {
     if(e.a===to.accessId||e.b===to.accessId) {
       const from=e.a===to.accessId?e.b:e.a;
       directionalBlocks.set('test:'+from,{from,to:to.accessId,until:7,incidentId:77});
     }
   }
   planRecoveryDrops(rescue);
   if(rescue.state!=='recovery_wait')throw Error('recovery should wait for closed destination');
   const effects=passengerTransfers.length;
   for(let i=0;i<10;i++)tickEmergencyVehicles();
   if(rescue.riders[0]!==request||passengerTransfers.length!==effects||request.pickedUpAt!==1)throw Error('retry lost rider or repeated transfer');
   simElapsed=7;tickEmergencyVehicles();
   if(rescue.state!=='enroute_dropoff'||!rescue.route)throw Error('recovery did not resume after reopening');
 `);
}
console.log('PASS: recovery safely waits for a closed destination and retries without duplicate transfers.');
// Private traffic persists to destination and owns real route reservations.
{
 const {run,elements}=boot(834);
 run(`
   dbg=()=>{};cars.length=0;for(const edge of Object.values(edges))edge.claims.clear();
   const human=spawnHumanCar();
   if(!human||human.kind!=='human'||!human.route.edges.length)throw Error('human did not start driving');
   const reserved=human.route.edges.length/N_EDGES;
   if(Math.abs(gridlockBreakdown().values.human-reserved)>1e-10)throw Error('private traffic missing from gridlock');
   const originalRoute=human.route;
   for(let i=0;i<5000&&human.state!=='human_done';i++){simElapsed+=SIM_MIN_PER_TICK;tickHumanTraffic();tickStoplights();stepCars(1);}
   if(human.state!=='human_done'||!highwayExits.includes(human.nodeId))throw Error('private trip never reached interstate exit');
   if(completedCount!==0)throw Error('private trip polluted transit completions');
   if(Object.values(edges).some(e=>e.claims.has(human.id)))throw Error('private claims leaked');
   tickEmergencyVehicles();if(cars.includes(human))throw Error('arrived private car not removed');
   // Baseline equals the old average mixed-obstacle human spawn rate.
   if(Math.abs(HUMAN_BASE_INTERVAL-11.925)>1e-10)throw Error('wrong baseline');
   let arrivals=0;spawnHumanCar=()=>{arrivals++;return {};};
   humanTrafficRate=1;humanSpawnCredit=0;for(let i=0;i<2400;i++)tickHumanTraffic();
   const baseline=arrivals;
   humanTrafficRate=10;humanSpawnCredit=0;arrivals=0;for(let i=0;i<2400;i++)tickHumanTraffic();
   if(baseline!==10||arrivals!==100)throw Error('slider rate does not scale arrivals');
 `);
 elements.get('reset').click();assert.equal(run('cars.some(c=>c.kind==="human")||humanSpawnCredit!==0'),false);
}
console.log('PASS: persistent human trips, route pressure, arrival cleanup, transit metric isolation, baseline and 10× arrival rate.');
// A waiting leader slows followers on its own lane only, including across nodes.
{
 const {run}=boot(146);
 run(`
   dbg=()=>{};cars.length=0;
   const edge=Object.values(edges).find(e=>!e.oneWay&&e.length>.5),key=edgeKey(edge.a,edge.b);
   const leader=makeCar('human','human-leader'),follower=makeCar('sedan','sed-follower'),opposite=makeCar('sedan','sed-opposite');
   for(const c of [leader,follower,opposite]) {
     c.state='human_driving';c.nodeId=c===opposite?edge.b:edge.a;
     setRoute(c,{nodes:c===opposite?[edge.b,edge.a]:[edge.a,edge.b],edges:[key],cost:edge.length});cars.push(c);
   }
   leader.progress=.5;leader.state='redlight_wait';leader._waitingAtNode=-1;leader._fromEdge=key;
   follower.progress=.3;opposite.progress=.3;
   const available=(.5-.3)*edge.length*METERS_PER_CELL-8;
   if(Math.abs(followingRoom(follower,trafficSnapshot(),100)-Math.max(0,available))>1e-8)throw Error('wrong following gap');
   if(followingRoom(opposite,trafficSnapshot(),100)!==Infinity)throw Error('opposite lane falsely blocked');
   stepCars(1,follower);
   if((leader.progress-follower.progress)*edge.length*METERS_PER_CELL<8-1e-7)throw Error('follower drove through human car');
   const next=(adj[edge.b]||[]).find(n=>n.to!==edge.a);
   if(next) {
     setRoute(follower,{nodes:[edge.a,edge.b,next.to],edges:[key,next.key],cost:1});follower.progress=.95;
     setRoute(leader,{nodes:[edge.b,next.to],edges:[next.key],cost:1});leader.progress=0;
     const room=followingRoom(follower,trafficSnapshot(),100);
     if(room>Math.max(0,.05*edge.length*METERS_PER_CELL-8)+1e-7)throw Error('failed to look across intersection');
   }
 `);
}
console.log('PASS: eight-meter following gap, human/fleet interaction, opposite-lane independence and intersection lookahead.');
{
 const {run}=boot(687);
 run(`
   dbg=()=>{};cars.length=0;for(const e of Object.values(edges))e.claims.clear();
   const key=Object.keys(edges)[0],edge=edges[key];
   for(const [kind,id] of [['sedan','public'],['human','private'],['police','officer']]) {
     cars.push(makeCar(kind,id));edge.claims.add(id);
   }
   directionalBlocks.set('test',{from:edge.a,to:edge.b,until:100,incidentId:1});
   ix.obstacles.push({kind:'parked truck',edgeKey:key,active:true});
   const pressure=gridlockBreakdown();
   if(Object.values(pressure.values).some(v=>Math.abs(v-1/N_EDGES)>1e-10))throw Error('breakdown missing component or double counted obstruction');
   if(Math.abs(pressure.total-4/N_EDGES)>1e-10)throw Error('chart does not sum to score');
   updateHUD();
 `);
}
console.log('PASS: gridlock breakdown separates public, private, response and deduplicated obstructions; contributions sum to total.');
{
 const {run,elements}=boot(908);
 run(`
   dbg=()=>{};cars.length=0;nextLocalTrainStop=()=>null; // isolate scheduled platform service
   const station=buildingByName('Central Stn');
   if(station.col!==0||station.row!==0)throw Error('station not in corner');
   const first=railSegments[0];
   if(Math.abs(Math.atan2(first.b[1]-first.a[1],first.b[0]-first.a[0])*180/Math.PI-75)>1e-8)throw Error('approach not 75 degrees');
   if(!dijkstra(CENTRAL_NODE,parkRide.accessId)||!dijkstra(parkRide.accessId,CENTRAL_NODE))throw Error('park-and-ride has no road access');
   if(railCrossings.length<5)throw Error('missing rail crossings');
   for(let i=0;i<80;i++)railWaiting.get(parkRide.name).push({id:'park-'+i});
   startTrain({count:100});tickTrains();
   const train=trains[0];
   if(train.riders.length!==60)throw Error('incoming train capacity wrong');
   let centralDrop=false,parkDrop=false,passedPark=false,sawGate=false;
   for(let i=0;i<5000&&trains.length;i++) {
     simElapsed+=SIM_MIN_PER_TICK;tickTrains();
     if(train.riders.length>60)throw Error('train exceeded capacity');
     if(railBlockedEdges.size)sawGate=true;
     if(train.state==='dwelling'&&train.nextStop==='central')centralDrop=true;
     if(train.state==='dwelling'&&train.nextStop==='park'){
       parkDrop=true;if(train.riders.length!==60)throw Error('terminal boarding did not fill available seats');
     }
     if(train.direction!==1)throw Error('through train reversed');if(train.distance>parkRailDistance+100)passedPark=true;
   }
   if(!centralDrop||!parkDrop||!passedPark||!sawGate||trains.length||railBlockedEdges.size)throw Error('incomplete through service or gate cleanup');
   if(railWaiting.get(parkRide.name).length!==20)throw Error('excess passengers must remain waiting');
   if(queue.filter(r=>r.from===station).length!==40||queue.filter(r=>r.from===parkRide).length!==20)throw Error('alighting riders not handed to fleet');
   const crossing=railCrossings.find(c=>c.distance>centralRailDistance+200&&c.distance<railLength-200);
   startTrain({count:10});const probe=trains[0];probe.distance=crossing.distance+50;probe.state='dwelling';probe.dwellUntil=simElapsed+10;
   tickTrains();if(!railBlockedEdges.has(crossing.key))throw Error('gate opened before rear cleared');
   const edge=edges[crossing.key];
   if(!directionBlocked(edge.a,edge.b)||!directionBlocked(edge.b,edge.a))throw Error('crossing must stop both directions');
   const roadCar=makeCar('sedan','gate-test');roadCar.nodeId=edge.a;roadCar.state='returning';
   setRoute(roadCar,{nodes:[edge.a,edge.b],edges:[crossing.key],cost:1});roadCar.progress=.3;cars.push(roadCar);
   stepCars(1,roadCar);if(roadCar.progress!==.3)throw Error('vehicle ignored gate');
   probe.distance=crossing.distance+140;tickTrains();
   if(railBlockedEdges.has(crossing.key))throw Error('gate stayed closed after full train cleared');
 `);
 elements.get('reset').click();assert.equal(run('trains.length+trainJobs.length+railBlockedEdges.size+[...railWaiting.values()].reduce((n,a)=>n+a.length,0)'),0);
}
console.log('PASS: corner station, 75-degree approach, road-connected terminal, 60-person train, both station transfers, capacity overflow, through service and full-length crossing protection.');
for(const direction of [1,-1]) {
 const {run}=boot(1209);
 run(`
   dbg=()=>{};cars.length=0;queue.length=0;
   const candidates=BUILDINGS.map(b=>({b,stop:buildingRailStop(b)})).filter(x=>x.stop&&x.stop.distance>centralRailDistance+CELL&&x.stop.distance<parkRailDistance-CELL).sort((a,b)=>a.stop.distance-b.stop.distance);
   const from=${direction}>0?candidates[0]:candidates.at(-1),to=${direction}>0?candidates.at(-1):candidates[0];
   const train={id:'flex-test',direction:${direction},state:'moving',nextStop:${direction}>0?'park':'central-westbound',riders:Array.from({length:59},()=>({exitAt:'metro'}))};
   const pickup=localStopDistance(train,from.stop.distance);
   train.distance=pickup-(${direction})*CELL*.4;trains.push(train);
   const request={id:70001,requestedAt:0,from:from.b,to:to.b,pickupId:from.b.accessId,dropoffId:to.b.accessId};
   const excess={...request,id:70002},reverse={...request,id:70003,from:to.b,to:from.b};
   const far={...request,id:70004,from:{x:1e6,y:1e6}};
   const assigned={...request,id:70005};const car=makeCar('sedan','assigned-car');car.pickupQueue=[assigned];cars.push(car);
   queue.push(request,excess,reverse,far);
   for(let i=0;i<3000&&request.completedAt==null;i++){simElapsed+=SIM_MIN_PER_TICK;tickTrains();if(train.riders.length>60)throw Error('flex pickup exceeded capacity');}
   if(request.pickedUpAt==null||request.completedAt==null||completedCount!==1)throw Error('flex rider not delivered');
   if(request.completedAt<=request.pickedUpAt||boardedQueueCount!==1)throw Error('incorrect per-rider timing');
   if(!queue.includes(excess)||!queue.includes(reverse)||!queue.includes(far))throw Error('capacity, wrong-way or far-away request incorrectly picked up');
   if(assigned.pickedUpAt!=null||car.pickupQueue[0]!==assigned)throw Error('stole road-assigned request');
   if(train.nextStop!==(${direction}>0?'park':'central-westbound'))throw Error('extra dwell skipped scheduled station or reversed train');
 `);
}
console.log('PASS: flexible pickups/dropoffs in both directions, 60-seat limit, per-rider metrics, distant/wrong-way exclusion and preservation of road assignments.');
{
 const {run}=boot(2345);
 run(`
   dbg=()=>{};cars.length=0;nextLocalTrainStop=()=>null;
   scheduleTrain({count:12});
   if(trainJobs.length!==2)throw Error('scheduled frequency did not double');
   tickTrains();
   if(trains.length!==1||trains[0].direction!==1||trainJobs.length!==1)throw Error('opposing services launched together');
   simElapsed=14.95;tickTrains();
   if(trains.length!==1)throw Error('opposing service launched early');
   simElapsed=15;tickTrains();
   if(trains.length!==2||!trains.some(t=>t.direction===1)||!trains.some(t=>t.direction===-1))throw Error('missing opposing service');
   const east=trains.find(t=>t.direction===1),west=trains.find(t=>t.direction===-1),visits=new Map([[east,[]],[west,[]]]);
   const end=railPoints.at(-1);
   if(end[0]>=worldBounds[0]&&end[0]<=worldBounds[2]&&end[1]>=worldBounds[1]&&end[1]<=worldBounds[3])throw Error('rail extension ends inside map');
   if(parkRailDistance>=railLength)throw Error('park still terminal');
   for(let i=0;i<5000&&trains.length;i++) {
     simElapsed+=SIM_MIN_PER_TICK;tickTrains();
     for(const t of [east,west]) {
       if(t.direction!==(t===east?1:-1))throw Error('train reversed');
       const stops=visits.get(t);
       if(t.state==='dwelling'&&stops.at(-1)!==t.nextStop)stops.push(t.nextStop);
       if(t.riders.length>60)throw Error('train over capacity');
     }
   }
   if(trains.length||railBlockedEdges.size)throw Error('through trains/gates failed to clear');
   if(visits.get(east).join(',')!=='central,park'||visits.get(west).join(',')!=='park,central-westbound')throw Error('wrong station service order');
   if(east.distance<=railLength||west.distance>=0)throw Error('train left via wrong map end');
   const a=trainPoint(east,centralRailDistance+200),b=trainPoint(west,centralRailDistance+200);
   if(Math.abs(Math.hypot(a.x-b.x,a.y-b.y)-24)>1e-8)throw Error('opposing services not separated');
 `);
}
console.log('PASS: doubled bidirectional services, both station orders, no reversal, opposite map exits, parallel tracks and crossing cleanup.');
{
 const {run}=boot(665);
 run(`
   dbg=()=>{};cars.length=0;queue.length=0;
   for(const d of developments) {
     const route=dijkstra(d.gate,d.entry),a=nodeXY(d.gate),b=nodeXY(d.entry);
     if(!route.nodes.some(n=>{const p=nodeXY(n);return Math.abs((p[0]-a[0])*(b[1]-a[1])-(p[1]-a[1])*(b[0]-a[0]))>1;}))throw Error('straight development connector');
   }
   const radius=d=>{const p=nodeXY(d.entry);return Math.hypot(p[0]-390,p[1]-390);};
   if(developments.some(d=>radius(d)>radius(highwayDevelopment)+1e-8))throw Error('interstate placed in wrong development');
   for(const entrance of highwayEntrances)if(!dijkstra(entrance,highwayDevelopment.entry))throw Error('off-ramp disconnected');
   for(const exit of highwayExits)if(!dijkstra(highwayDevelopment.entry,exit))throw Error('on-ramp disconnected');
   for(const n of [...highwayEntrances,...highwayExits]) {const [x,y]=nodeXY(n);if(x>=worldBounds[0]&&x<=worldBounds[2]&&y>=worldBounds[1]&&y<=worldBounds[3])throw Error('interstate ends on map');}
   humanTrafficRate=2;humanSpawnCredit=-1e9;retainedSpawnCredit=1;
   let retainedIds=[];
   for(let i=0;i<2000;i++){simElapsed+=SIM_MIN_PER_TICK;tickHumanTraffic();tickStoplights();stepCars(1);tickEmergencyVehicles();}
   const retained=cars.filter(c=>c.retainedTraffic);retainedIds=retained.map(c=>c.id);
   if(retained.length!==5||retained.some(c=>c.exitingMetro))throw Error('added cars failed to remain in metro');
   humanTrafficRate=1;let sawExit=false;
   for(let i=0;i<5000&&cars.some(c=>c.retainedTraffic);i++){simElapsed+=SIM_MIN_PER_TICK;tickHumanTraffic();tickStoplights();stepCars(1);sawExit ||= cars.some(c=>c.retainedTraffic&&c.exitingMetro);tickEmergencyVehicles();}
   if(!sawExit||cars.some(c=>retainedIds.includes(c.id)))throw Error('reduced traffic failed to depart via interstate');
 `);
}
console.log('PASS: curved development connectors, outermost interchange, directed ramps, off-map interstate portals, retained traffic target and departures after slider reduction.');

{
 const {run,elements}=boot(913);
 for(let restart=0;restart<2;restart++) {
   run(`
     for(let i=0;i<29;i++){advanceSimulationTime(SIM_MIN_PER_TICK);tickEvents();tickTrains();}
     if(trains.length)throw Error('first train started before startup delay');
     for(let i=0;i<2;i++){advanceSimulationTime(SIM_MIN_PER_TICK);tickEvents();tickTrains();}
     if(trains.length!==1||trains[0].direction!==1||trainJobs.length!==1)throw Error('startup train missing or simultaneous');
   `);
   elements.get('reset').click();
 }
}
console.log('PASS: first service after three seconds of 1× playback, repeated after reset; opposing train delayed 15 simulated minutes.');
