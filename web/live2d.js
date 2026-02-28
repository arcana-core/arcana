(function(){
  // Default model path; adjust if you change model location/name
  const MODEL_URL = '/models/arcana/runtime/hiyori_pro_t11.model3.json';
  const stage = document.getElementById('live2d-stage');
  if (!stage) { console.warn('[live2d] #live2d-stage not found'); return; }

  // Wait for dependencies reliably, then init
  function waitFor(cond, { timeout=5000, interval=50 }={}){
    return new Promise((resolve, reject)=>{
      const start = Date.now();
      const timer = setInterval(()=>{
        try{
          if (cond()) { clearInterval(timer); resolve(Date.now()-start); }
          else if (Date.now()-start >= timeout) { clearInterval(timer); reject(new Error('timeout')); }
        }catch(e){ clearInterval(timer); reject(e); }
      }, interval);
    });
  }

  (async () => {
    try {
      // Ensure PIXI, Cubism Core and plugin are all present
      await waitFor(()=> !!(window.PIXI && window.Live2DCubismCore && PIXI.live2d), { timeout: 5000, interval: 50 });

      if (!window.PIXI) { console.warn('[live2d] PIXI not loaded (check CDN)'); return; }
      if (!window.Live2DCubismCore) { console.warn('[live2d] Live2D Cubism Core not loaded'); return; }
      if (!PIXI.live2d) { console.warn('[live2d] pixi-live2d-display not loaded'); return; }

      // Create transparent PIXI app bound to the container size
      const app = new PIXI.Application({
        backgroundAlpha: 0,
        antialias: true,
        stencil: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
        powerPreference: 'high-performance',
        resizeTo: stage
      });
      stage.appendChild(app.view);

      const { Live2DModel } = PIXI.live2d;
      const model = await Live2DModel.from(MODEL_URL);
      app.stage.addChild(model);
      window.__live2d = { app, model };

      // drive updates explicitly for safety
      app.ticker.add(() => { try { model.update(app.ticker.deltaMS); } catch(_){} });

      // Place bottom; slight left inset; anchor at bottom center for stable scaling
      model.anchor.set(0.5, 1);

      function fit(){
        const r = app.renderer;
        const W = r.width;  // physical px
        const H = r.height; // physical px
        // Measure natural bounds at scale 1
        const prevSx = model.scale.x, prevSy = model.scale.y;
        model.scale.set(1);
        model.update(0);
        const b = model.getLocalBounds();
        const bw = Math.max(1, b.width);
        const bh = Math.max(1, b.height);
        // Contain inside stage with small margin
        const margin = 0.96;
        const s = Math.min(W / bw, H / bh) * margin;
        model.scale.set(s);
        // Position: left-ish; keep a minimal left margin so it never clips
        const leftMargin = Math.round(W * 0.04 + 12);
        const x = Math.max(leftMargin, Math.min(W - leftMargin, Math.round(W * 0.30)));
        model.position.set(x, H);
      }
      // initial fit after next microtask to ensure layout settled
      setTimeout(fit, 0);
      window.addEventListener('resize', fit);
      if (window.ResizeObserver) new ResizeObserver(()=>fit()).observe(stage);

      // Build a temporary motion controls panel by reading the model3.json motions
      try {
        const motions = await (await fetch(MODEL_URL, { cache: 'no-store' })).json();
        const groups = (motions && motions.FileReferences && motions.FileReferences.Motions) || {};
        buildLive2DControls(groups, model);
      } catch (e) {
        console.warn('[live2d] unable to load motions for controls', e);
      }

      // Auto-play Idle group if available
      try { model.motion('Idle').play({ loop: true }); } catch (_) {}
    } catch (e) {
      console.warn('[live2d] dependencies not ready in time or init failed:', e && e.message ? e.message : e);
    }
  })();

  function buildLive2DControls(groups, model){
    // ensure container
    let panel = document.getElementById('live2d-controls');
    if (!panel){
      panel = document.createElement('div');
      panel.id = 'live2d-controls';
      const toolbar = document.createElement('div');
      toolbar.className = 'toolbar';
      const title = document.createElement('div');
      title.textContent = 'Live2D 动作';
      title.style.fontWeight = '600';
      title.style.marginRight = '8px';
      const btnHide = document.createElement('button');
      btnHide.className = 'btn'; btnHide.textContent = '隐藏';
      btnHide.onclick = ()=>{ panel.style.display = 'none'; };
      const btnIdle = document.createElement('button');
      btnIdle.className = 'btn'; btnIdle.textContent = 'Idle 循环';
      btnIdle.onclick = ()=>{ try{ model.motion('Idle').play({ loop:true }); }catch(e){} };
      toolbar.appendChild(title); toolbar.appendChild(btnIdle); toolbar.appendChild(btnHide);
      panel.appendChild(toolbar);
      document.body.appendChild(panel);
    } else {
      panel.innerHTML = '';
    }
    // rebuild toolbar if cleared
    if (!panel.querySelector('.toolbar')){
      const toolbar = document.createElement('div');
      toolbar.className = 'toolbar';
      const title = document.createElement('div'); title.textContent = 'Live2D 动作'; title.style.fontWeight='600'; title.style.marginRight='8px';
      const btnHide = document.createElement('button'); btnHide.className='btn'; btnHide.textContent='隐藏'; btnHide.onclick=()=>{ panel.style.display='none'; };
      const btnIdle = document.createElement('button'); btnIdle.className='btn'; btnIdle.textContent='Idle 循环'; btnIdle.onclick=()=>{ try{ model.motion('Idle').play({ loop:true }); }catch(e){} };
      toolbar.appendChild(title); toolbar.appendChild(btnIdle); toolbar.appendChild(btnHide);
      panel.appendChild(toolbar);
    }
    // list groups
    const keys = Object.keys(groups);
    for (const g of keys){
      const arr = Array.isArray(groups[g]) ? groups[g] : [];
      const row = document.createElement('div'); row.className = 'group';
      const glabel = document.createElement('div'); glabel.className = 'glabel'; glabel.textContent = g + ' (' + arr.length + ')';
      row.appendChild(glabel);
      const chips = document.createElement('div'); chips.className = 'chips';
      arr.forEach((_, idx)=>{
        const chip = document.createElement('div');
        chip.className = 'chip'; chip.textContent = String(idx+1);
        chip.title = g + '[' + idx + ']';
        chip.onclick = ()=>{
          try {
            const handle = typeof idx === 'number' ? model.motion(g, idx) : model.motion(g);
            if (handle && handle.play) handle.play({ loop: /idle/i.test(g) });
          } catch (e) { console.warn('[live2d] play failed', g, idx, e); }
        };
        chips.appendChild(chip);
      });
      row.appendChild(chips);
      panel.appendChild(row);
    }
  }
})();
