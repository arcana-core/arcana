import { readFileSync } from 'node:fs';
import { loadWechatCredentials } from '../skills/wechat-oa/tools/wechat/credentials.js';
import { getAccessToken } from '../skills/wechat-oa/tools/wechat/token.js';
import { addMaterial, draftAdd, freepublishSubmit, freepublishGet } from '../skills/wechat-oa/tools/wechat/api.js';
import { createSafeOps } from './tools/safe-ops.js';

function idxOf(args, flag){ const i = args.indexOf(flag); return i > -1 ? i : -1; }
function val(args, flag){ const i = idxOf(args, flag); return i>-1 ? args[i+1] : undefined; }
function has(args, flag){ return idxOf(args, flag) > -1; }

async function cmdToken(args){
  const force = has(args, '--force');
  const show = has(args, '--show-token');
  const opAppIdRef = val(args, '--op-appid');
  const opSecretRef = val(args, '--op-secret');
  const { appId, appSecret, source } = await loadWechatCredentials({ opAppIdRef, opSecretRef });
  const safeOps = createSafeOps({ allowedHosts:["api.weixin.qq.com:443"], allowedWritePaths:["arcana/.cache/wechat"] });
  const token = await getAccessToken({ appId, appSecret, force, safeOps });
  console.log('[arcana:wechat] token: ' + (show ? token : 'ok (cached)'));
}

async function cmdUploadCover(args){
  const file = args[0];
  if (!file) throw new Error('usage: arcana wechat upload-cover <file> [--type image]');
  const type = val(args, '--type') || 'image';
  const opAppIdRef = val(args, '--op-appid');
  const opSecretRef = val(args, '--op-secret');
  const { appId, appSecret } = await loadWechatCredentials({ opAppIdRef, opSecretRef });
  const safeOps = createSafeOps({ allowedHosts:["api.weixin.qq.com:443"], allowedWritePaths:["arcana/.cache/wechat"] });
  const accessToken = await getAccessToken({ appId, appSecret, force:false, safeOps });
  const r = await addMaterial({ accessToken, type, filePath: file, safeOps });
  const id = r.media_id || r.thumb_media_id || r.mediaId || r.id;
  if (!id) throw new Error('Upload succeeded but no media_id returned');
  console.log('[arcana:wechat] thumb_media_id: ' + id + (r.url ? (' url: ' + r.url) : ''));
}

async function cmdDraft(args){
  const title = val(args, '--title');
  const contentFile = val(args, '--content-file');
  const thumbMediaId = val(args, '--thumb-media-id');
  if (!title || !contentFile || !thumbMediaId) throw new Error('usage: arcana wechat draft --title ... --content-file <html> --thumb-media-id <id> [--author ... --digest ...]');
  const author = val(args, '--author');
  const digest = val(args, '--digest');
  const opAppIdRef = val(args, '--op-appid');
  const opSecretRef = val(args, '--op-secret');
  const { appId, appSecret } = await loadWechatCredentials({ opAppIdRef, opSecretRef });
  const safeOps = createSafeOps({ allowedHosts:["api.weixin.qq.com:443"], allowedWritePaths:["arcana/.cache/wechat"] });
  const accessToken = await getAccessToken({ appId, appSecret, force:false, safeOps });
  const content = String(readFileSync(contentFile));
  const article = { title, author, digest, content, thumb_media_id: thumbMediaId };
  // Remove undefined optional fields
  Object.keys(article).forEach(k=>{ if (article[k] === undefined || article[k] === '') delete article[k]; });
  const r = await draftAdd({ accessToken, article, safeOps });
  const id = r.media_id || r.mediaId || r.id;
  if (!id) throw new Error('Draft creation succeeded but no media_id returned');
  console.log('[arcana:wechat] draft media_id: ' + id);
}

async function pollPublish({ accessToken, publishId, timeoutSec }){
  const start = Date.now();
  while (true){
    const r = await freepublishGet({ accessToken, publishId });
    const status = (r.publish_status !== undefined) ? r.publish_status : (r.status !== undefined ? r.status : undefined);
    if (status === 0) return r;           // success
    if (status !== 1 && status !== undefined) { // known failure/non-pending
      const err = new Error('Publish failed with status=' + status);
      err.data = r; throw err;
    }
    if (timeoutSec && (Date.now() - start) > timeoutSec*1000){
      const err = new Error('Publish wait timed out'); err.data = r; throw err;
    }
    await new Promise(res=>setTimeout(res, 2000));
  }
}

async function cmdPublish(args){
  const mediaId = val(args, '--media-id');
  const wait = has(args, '--wait');
  const timeoutSec = Number(val(args, '--timeout-sec')||'300');
  if (!mediaId) throw new Error('usage: arcana wechat publish --media-id <draftMediaId> [--wait] [--timeout-sec n]');
  const opAppIdRef = val(args, '--op-appid');
  const opSecretRef = val(args, '--op-secret');
  const { appId, appSecret } = await loadWechatCredentials({ opAppIdRef, opSecretRef });
  const safeOps = createSafeOps({ allowedHosts:["api.weixin.qq.com:443"], allowedWritePaths:["arcana/.cache/wechat"] });
  const accessToken = await getAccessToken({ appId, appSecret, force:false, safeOps });
  const r = await freepublishSubmit({ accessToken, mediaId, safeOps });
  const publishId = r.publish_id || r.publishId || r.id;
  if (!publishId) throw new Error('Publish submission succeeded but no publish_id returned');
  console.log('[arcana:wechat] publish_id: ' + publishId);
  if (wait){
    const out = await pollPublish({ accessToken, publishId, timeoutSec });
    const articles = out.article_id || out.article_ids || out.article_id_list || [];
    console.log('[arcana:wechat] publish status: ok' + (articles && articles.length ? (' articles: ' + JSON.stringify(articles)) : ''));
  }
}

async function cmdPublishFile(args){
  // draft + publish convenience
  const title = val(args, '--title');
  const contentFile = val(args, '--content-file');
  const thumbMediaId = val(args, '--thumb-media-id');
  const wait = has(args, '--wait');
  if (!title || !contentFile || !thumbMediaId) throw new Error('usage: arcana wechat publish-file --title ... --content-file <html> --thumb-media-id <id> [--wait]');
  const author = val(args, '--author');
  const digest = val(args, '--digest');
  const opAppIdRef = val(args, '--op-appid');
  const opSecretRef = val(args, '--op-secret');
  const { appId, appSecret } = await loadWechatCredentials({ opAppIdRef, opSecretRef });
  const safeOps = createSafeOps({ allowedHosts:["api.weixin.qq.com:443"], allowedWritePaths:["arcana/.cache/wechat"] });
  const accessToken = await getAccessToken({ appId, appSecret, force:false, safeOps });
  const content = String(readFileSync(contentFile));
  const article = { title, author, digest, content, thumb_media_id: thumbMediaId };
  Object.keys(article).forEach(k=>{ if (article[k] === undefined || article[k] === '') delete article[k]; });
  const r1 = await draftAdd({ accessToken, article, safeOps });
  const mediaId = r1.media_id || r1.mediaId || r1.id;
  if (!mediaId) throw new Error('Draft creation succeeded but no media_id returned');
  console.log('[arcana:wechat] draft media_id: ' + mediaId);
  const r2 = await freepublishSubmit({ accessToken, mediaId, safeOps });
  const publishId = r2.publish_id || r2.publishId || r2.id;
  if (!publishId) throw new Error('Publish submission succeeded but no publish_id returned');
  console.log('[arcana:wechat] publish_id: ' + publishId);
  if (wait){
    const out = await pollPublish({ accessToken, publishId, timeoutSec: 300 });
    const status = (out.publish_status !== undefined) ? out.publish_status : (out.status !== undefined ? out.status : undefined);
    if (status === 0) console.log('[arcana:wechat] publish status: ok');
  }
}

export async function wechatCLI({ args }){
  const [, sub, ...rest] = args;
  const s = String(sub||'').toLowerCase();
  if (s === 'token') return cmdToken(rest);
  if (s === 'upload-cover') return cmdUploadCover(rest);
  if (s === 'draft') return cmdDraft(rest);
  if (s === 'publish') return cmdPublish(rest);
  if (s === 'publish-file') return cmdPublishFile(rest);
  console.log('[arcana] usage: arcana wechat token [--force] [--show-token] | upload-cover <file> [--type image] | draft --title ... --content-file <html> --thumb-media-id <id> [--author ... --digest ...] | publish --media-id <draftMediaId> [--wait] [--timeout-sec n] | publish-file --title ... --content-file <html> --thumb-media-id <id> [--wait]');
}

export default { wechatCLI };
