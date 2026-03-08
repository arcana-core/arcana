const queues = new Map();

function getKey(parts){
  const arr = Array.isArray(parts) ? parts : [parts];
  return arr.map((p)=>{
    const s = String(p ?? '').trim();
    return s || '_';
  }).join('::');
}

async function runQueue(key){
  const q = queues.get(key);
  if (!q || !q.length) {
    queues.delete(key);
    return;
  }
  const item = q[0];
  try {
    const result = await item.fn();
    item.resolve(result);
  } catch (e) {
    item.reject(e);
  } finally {
    q.shift();
    if (!q.length){
      queues.delete(key);
    } else {
      runQueue(key);
    }
  }
}

export function runInLane(keyParts, fn){
  if (typeof fn !== 'function') return Promise.resolve(null);
  const key = getKey(keyParts || ['_']);
  return new Promise((resolve, reject) => {
    const entry = { fn, resolve, reject };
    let q = queues.get(key);
    if (!q){
      q = [];
      queues.set(key, q);
    }
    q.push(entry);
    if (q.length === 1){
      runQueue(key);
    }
  });
}

export default { runInLane };

