import Meting from '@meting/core'
import aesjs from 'aes-js'
import { createHash } from 'crypto'
import hashjs from 'hash.js'
import { HTTPException } from 'hono/http-exception'
import { loadConfig } from '../config.js'
import { format as lyricFormat } from '../utils/lyric.js'
import { readCookieAsync, isAllowedHost } from '../utils/cookie.js'
import { LRUCache } from 'lru-cache'

const cache = new LRUCache({
  max: 1000,
  ttl: 1000 * 30
})

// ============================================================
// 网易云 EAPI AES-ECB 补丁
// ============================================================
const patchNeteaseEapiEncrypt = (meting) => {
  const provider = meting?.provider
  if (!provider || provider.name !== 'netease') return

  const proto = Object.getPrototypeOf(provider)
  if (proto.__patchedEapi) return

  proto.__patchedEapi = true

  proto.eapiEncrypt = (req) => {
    const bodyStr = JSON.stringify(req.body)
    const path = req.url.replace(/https?:\/\/[^/]+/, '')
    const signSeed = `nobody${path}use${bodyStr}md5forencrypt`
    const sign = createHash('md5').update(signSeed).digest('hex')

    const payload =
      `${path}-36cd479b6b5-${bodyStr}-36cd479b6b5-${sign}`

    const key = Buffer.from('e82ckenh8dichen8', 'utf8')
    const textBytes = Buffer.from(payload, 'utf8')
    const padded = aesjs.padding.pkcs7.pad(textBytes)

    const aesEcb = new aesjs.ModeOfOperation.ecb(key)
    const encryptedBytes = aesEcb.encrypt(padded)

    const encryptedHex =
      Buffer.from(encryptedBytes).toString('hex').toUpperCase()

    req.url = req.url.replace('/api/', '/eapi/')
    req.body = {
      params: encryptedHex
    }

    return req
  }
}

// ============================================================
// Meting 方法映射
// ============================================================
const METING_METHODS = {
  search: 'search',
  song: 'song',
  album: 'album',
  artist: 'artist',
  playlist: 'playlist',
  lrc: 'lyric',
  url: 'url',
  pic: 'pic'
}

// ============================================================
// QQ 音乐搜索
//
// 基于 @meting/core 1.6.0 TencentProvider 的实际请求。
// 1.6.0 使用：
// https://c.y.qq.com/soso/fcgi-bin/client_search_cp
// ============================================================
async function tencentSearch(keyword, cookie = '') {
  const url =
    'https://c.y.qq.com/soso/fcgi-bin/client_search_cp' +
    '?format=json' +
    '&p=1' +
    '&n=30' +
    '&w=' + encodeURIComponent(keyword) +
    '&aggr=1' +
    '&lossless=1' +
    '&cr=1' +
    '&new_json=1'

  const headers = {
    Referer: 'http://y.qq.com',
    'User-Agent':
      'QQ%E9%9F%B3%E4%B9%90/54409 CFNetwork/901.1 Darwin/17.6.0 (x86_64)',
    Accept: '*/*',
    'Accept-Language':
      'zh-CN,zh;q=0.8,gl;q=0.6,zh-TW;q=0.4',
    'Content-Type': 'application/x-www-form-urlencoded'
  }

  if (cookie) {
    headers.Cookie = cookie
  }

  const response = await fetch(url, {
    method: 'GET',
    headers
  })

  const rawText = await response.text()

  console.log('QQ_SEARCH_STATUS:', response.status)
  console.log(
    'QQ_SEARCH_RESPONSE:',
    rawText.substring(0, 3000)
  )

  if (!response.ok) {
    throw new Error(
      `QQ搜索 HTTP ${response.status}: ${rawText.substring(0, 800)}`
    )
  }

  let json

  try {
    json = JSON.parse(rawText)
  } catch (error) {
    throw new Error(
      `QQ搜索返回不是JSON: ${rawText.substring(0, 800)}`
    )
  }

  const songs = json?.data?.song?.list

  if (!Array.isArray(songs)) {
    throw new Error(
      `QQ搜索数据结构异常: ${JSON.stringify(json).substring(0, 1200)}`
    )
  }

  return songs.map((song) => ({
    id: song.songmid || String(song.songid || ''),
    name: song.songname || '',
    artist: Array.isArray(song.singer)
      ? song.singer.map((x) => x.name || '').filter(Boolean)
      : [],
    album: song.albumname || '',
    pic_id: song.albummid || '',
    url_id: song.songmid || String(song.songid || ''),
    lyric_id: song.songmid || String(song.songid || ''),
    source: 'tencent'
  }))
}

// ============================================================
// 主 API
// ============================================================
export default async (c) => {
  const config = loadConfig(c.env, c.req.url)

  const baseUrl =
    config.meting.url || new URL(c.req.url).origin

  const token =
    config.meting.token || 'token'

  // ==========================================================
  // 1. 参数
  // ==========================================================
  const query = c.req.query()

  const server =
    query.server || 'netease'

  const type =
    query.type || 'search'

  const id =
    query.id || 'hello'

  const authToken =
    query.token ||
    query.auth ||
    token

  // ==========================================================
  // 2. 参数校验
  // ==========================================================
  if (
    ![
      'netease',
      'tencent',
      'kugou',
      'baidu',
      'kuwo'
    ].includes(server)
  ) {
    throw new HTTPException(400, {
      message: 'server 参数不合法'
    })
  }

  if (
    ![
      'song',
      'album',
      'search',
      'artist',
      'playlist',
      'lrc',
      'url',
      'pic'
    ].includes(type)
  ) {
    throw new HTTPException(400, {
      message: 'type 参数不合法'
    })
  }

  // ==========================================================
  // 3. URL / LRC / PIC 鉴权
  // ==========================================================
  if (
    ['lrc', 'url', 'pic'].includes(type)
  ) {
    if (
      auth(server, type, id, token) !==
      authToken
    ) {
      throw new HTTPException(401, {
        message: '鉴权失败,非法调用'
      })
    }
  }

  // ==========================================================
  // 4. 缓存
  // ==========================================================
  const cacheKey =
    `${server}/${type}/${id}`

  let data = cache.get(cacheKey)

  if (data === undefined) {
    c.header('x-cache', 'miss')

    // ========================================================
    // 创建 Meting
    // ========================================================
    const meting =
      new Meting(server)

    patchNeteaseEapiEncrypt(meting)

    meting.format(true)

    // ========================================================
    // Cookie
    // ========================================================
    const referrer =
      c.req.header('referer')

    if (
      isAllowedHost(
        referrer,
        config.meting.cookie.allowHosts
      )
    ) {
      const cookie =
        await readCookieAsync(
          server,
          c.env
        )

      if (cookie) {
        meting.cookie(cookie)
      }
    }

    // ========================================================
    // QQ 音乐搜索：单独处理
    // ========================================================
    if (
      server === 'tencent' &&
      type === 'search'
    ) {
      try {
        const cookie =
          await readCookieAsync(
            server,
            c.env
          )

        data =
          await tencentSearch(
            id,
            cookie || ''
          )

        console.log(
          'QQ_SEARCH_COUNT:',
          Array.isArray(data)
            ? data.length
            : -1
        )
      } catch (error) {
        console.error(
          'QQ_SEARCH_ERROR:',
          error
        )

        // ====================================================
        // 搜索失败后，再尝试 @meting/core
        // ====================================================
        try {
          const response =
            await meting.search(id)

          data =
            JSON.parse(response)
        } catch (fallbackError) {
          console.error(
            'QQ_SEARCH_FALLBACK_ERROR:',
            fallbackError
          )

          throw new HTTPException(
            500,
            {
              message:
                error?.message ||
                'QQ音乐搜索失败'
            }
          )
        }
      }
    } else {
      // ======================================================
      // 其他所有平台 / 类型保持原来的 Meting 流程
      // ======================================================
      const method =
        METING_METHODS[type]

      let response

      try {
        response =
          await meting[method](id)
      } catch (error) {
        console.error(
          'Meting API error:',
          error
        )

        throw new HTTPException(
          500,
          {
            message:
              '上游 API 调用失败'
          }
        )
      }

      try {
        data =
          JSON.parse(response)
      } catch (error) {
        console.error(
          'JSON parse error:',
          error
        )

        throw new HTTPException(
          500,
          {
            message:
              '上游 API 返回格式异常'
          }
        )
      }
    }

    // ========================================================
    // 缓存
    // ========================================================
    cache.set(
      cacheKey,
      data,
      {
        ttl:
          type === 'url'
            ? 1000 * 60 * 10
            : 1000 * 60 * 60
      }
    )
  } else {
    c.header('x-cache', 'hit')
  }

  // ==========================================================
  // 5. URL
  // ==========================================================
  if (type === 'url') {
    let url =
      data?.url

    if (!url) {
      return c.body(null, 404)
    }

    if (server === 'netease') {
      url = url
        .replace(
          '://m7c.',
          '://m7.'
        )
        .replace(
          '://m8c.',
          '://m8.'
        )
        .replace(
          'http://',
          'https://'
        )

      if (url.includes('vuutv=')) {
        const tempUrl =
          new URL(url)

        tempUrl.search = ''

        url =
          tempUrl.toString()
      }
    }

    if (server === 'tencent') {
      url = url
        .replace(
          'http://',
          'https://'
        )
        .replace(
          '://ws.stream.qqmusic.qq.com',
          '://dl.stream.qqmusic.qq.com'
        )
    }

    if (server === 'baidu') {
      url = url.replace(
        'http://zhangmenshiting.qianqian.com',
        'https://gss3.baidu.com/y0s1hSulBw92lNKgpU_Z2jR7b2w6buu'
      )
    }

    return c.redirect(url)
  }

  // ==========================================================
  // 6. PIC
  // ==========================================================
  if (type === 'pic') {
    const url =
      data?.url

    if (!url) {
      return c.body(null, 404)
    }

    return c.redirect(url)
  }

  // ==========================================================
  // 7. LRC
  // ==========================================================
  if (type === 'lrc') {
    return c.text(
      lyricFormat(
        data?.lyric || '',
        data?.tlyric || ''
      )
    )
  }

  // ==========================================================
  // 8. 搜索 / 歌曲等统一输出
  // ==========================================================
  if (!Array.isArray(data)) {
    throw new HTTPException(
      500,
      {
        message:
          '接口返回数据不是数组'
      }
    )
  }

  return c.json(
    data.map((x) => {
      return {
        title:
          x.name || '',

        author:
          Array.isArray(x.artist)
            ? x.artist.join(' / ')
            : '',

        url:
          `${baseUrl}/api?server=${server}` +
          `&type=url&id=${encodeURIComponent(
            x.url_id || x.id || ''
          )}` +
          `&auth=${auth(
            server,
            'url',
            x.url_id || x.id || '',
            token
          )}`,

        pic:
          `${baseUrl}/api?server=${server}` +
          `&type=pic&id=${encodeURIComponent(
            x.pic_id || ''
          )}` +
          `&auth=${auth(
            server,
            'pic',
            x.pic_id || '',
            token
          )}`,

        lrc:
          `${baseUrl}/api?server=${server}` +
          `&type=lrc&id=${encodeURIComponent(
            x.lyric_id || x.id || ''
          )}` +
          `&auth=${auth(
            server,
            'lrc',
            x.lyric_id || x.id || '',
            token
          )}`
      }
    })
  )
}

// ============================================================
// HMAC-SHA1 鉴权
// ============================================================
const auth = (
  server,
  type,
  id,
  token
) => {
  return hashjs
    .hmac(hashjs.sha1, token)
    .update(
      `${server}${type}${id}`
    )
    .digest('hex')
}