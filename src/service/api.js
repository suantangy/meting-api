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
// 网易云 EAPI 加密
// ============================================================

const patchNeteaseEapiEncrypt = (meting) => {
  const provider = meting?.provider

  if (!provider || provider.name !== 'netease') {
    return
  }

  const proto = Object.getPrototypeOf(provider)

  if (proto.__patchedEapi) {
    return
  }

  proto.__patchedEapi = true

  proto.eapiEncrypt = (req) => {
    const bodyStr = JSON.stringify(req.body)

    const path = req.url.replace(
      /https?:\/\/[^/]+/,
      ''
    )

    const signSeed =
      `nobody${path}use${bodyStr}md5forencrypt`

    const sign = createHash('md5')
      .update(signSeed)
      .digest('hex')

    const payload =
      `${path}-36cd479b6b5-${bodyStr}-36cd479b6b5-${sign}`

    const key = Buffer.from(
      'e82ckenh8dichen8',
      'utf8'
    )

    const textBytes = Buffer.from(
      payload,
      'utf8'
    )

    const padded =
      aesjs.padding.pkcs7.pad(textBytes)

    const aesEcb =
      new aesjs.ModeOfOperation.ecb(key)

    const encryptedBytes =
      aesEcb.encrypt(padded)

    const encryptedHex =
      Buffer.from(encryptedBytes)
        .toString('hex')
        .toUpperCase()

    req.url =
      req.url.replace(
        '/api/',
        '/eapi/'
      )

    req.body = {
      params: encryptedHex
    }

    return req
  }
}

// ============================================================
// Meting 方法
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
// 使用 QQ 音乐新版 musicu.fcg
//
// 请求结构：
// {
//   req_1: {
//     method: "DoSearchForQQMusicDesktop",
//     module: "music.search.SearchCgiService",
//     param: {
//       num_per_page: 30,
//       page_num: 1,
//       query: keyword,
//       search_type: 0
//     }
//   }
// }
//
// search_type:
// 0 = 歌曲
// 1 = 歌手
// 2 = 专辑
// 3 = 歌单
// 7 = 歌词
// ============================================================

const tencentSearch = async (keyword) => {
  const url =
    'https://u.y.qq.com/cgi-bin/musicu.fcg'

  const payload = {
    req_1: {
      method:
        'DoSearchForQQMusicDesktop',

      module:
        'music.search.SearchCgiService',

      param: {
        num_per_page: 30,
        page_num: 1,
        query: keyword,
        search_type: 0
      }
    }
  }

  const response = await fetch(
    url,
    {
      method: 'POST',

      headers: {
        'Content-Type':
          'application/json',

        'Referer':
          'https://y.qq.com/',

        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
      },

      body: JSON.stringify(
        payload
      )
    }
  )

  const responseText =
    await response.text()

  if (!response.ok) {
    throw new Error(
      `QQ 搜索 HTTP ${response.status}: ${responseText.slice(0, 500)}`
    )
  }

  let json

  try {
    json =
      JSON.parse(responseText)
  } catch {
    throw new Error(
      `QQ 搜索返回非 JSON: ${responseText.slice(0, 500)}`
    )
  }

  // QQ 返回错误代码
  const result =
    json?.req_1

  if (!result) {
    throw new Error(
      `QQ 搜索缺少 req_1: ${JSON.stringify(json).slice(0, 1000)}`
    )
  }

  if (
    result.code !== undefined &&
    Number(result.code) !== 0
  ) {
    throw new Error(
      `QQ 搜索返回错误 code=${result.code}: ${JSON.stringify(result).slice(0, 1000)}`
    )
  }

  const songs =
    result?.data?.body?.song?.list

  if (!Array.isArray(songs)) {
    throw new Error(
      `QQ 搜索歌曲列表不存在: ${JSON.stringify(result).slice(0, 1500)}`
    )
  }

  return songs.map(
    (song) => {
      const singer =
        Array.isArray(song.singer)
          ? song.singer
          : []

      const artist =
        singer
          .map(
            (x) =>
              x?.name || ''
          )
          .filter(Boolean)

      return {
        id:
          song.mid ||
          String(
            song.id || ''
          ),

        name:
          song.name ||
          '',

        artist,

        album:
          song.album?.name ||
          '',

        pic_id:
          song.album?.mid ||
          '',

        url_id:
          song.mid ||
          String(
            song.id || ''
          ),

        lyric_id:
          song.mid ||
          String(
            song.id || ''
          ),

        source:
          'tencent'
      }
    }
  )
}

// ============================================================
// 主 API
// ============================================================

export default async (c) => {
  const config =
    loadConfig(
      c.env,
      c.req.url
    )

  const baseUrl =
    config.meting.url ||
    new URL(c.req.url).origin

  const token =
    config.meting.token ||
    'token'

  // ----------------------------------------------------------
  // 1. 参数
  // ----------------------------------------------------------

  const query =
    c.req.query()

  const server =
    query.server ||
    'netease'

  const type =
    query.type ||
    'search'

  const id =
    query.id ||
    'hello'

  const authToken =
    query.token ||
    query.auth ||
    token

  // ----------------------------------------------------------
  // 2. 参数校验
  // ----------------------------------------------------------

  if (
    ![
      'netease',
      'tencent',
      'kugou',
      'baidu',
      'kuwo'
    ].includes(server)
  ) {
    throw new HTTPException(
      400,
      {
        message:
          'server 参数不合法'
      }
    )
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
    throw new HTTPException(
      400,
      {
        message:
          'type 参数不合法'
      }
    )
  }

  // ----------------------------------------------------------
  // 3. 鉴权
  // ----------------------------------------------------------

  if (
    ['lrc', 'url', 'pic']
      .includes(type)
  ) {
    if (
      auth(
        server,
        type,
        id,
        token
      ) !== authToken
    ) {
      throw new HTTPException(
        401,
        {
          message:
            '鉴权失败,非法调用'
        }
      )
    }
  }

  // ----------------------------------------------------------
  // 4. QQ 音乐搜索
  //
  // QQ 搜索不使用 LRU 缓存。
  // 防止之前的 [] 被缓存。
  // ----------------------------------------------------------

  if (
    server === 'tencent' &&
    type === 'search'
  ) {
    let data

    try {
      data =
        await tencentSearch(id)
    } catch (error) {
      console.error(
        'QQ 音乐搜索失败:',
        error
      )

      throw new HTTPException(
        500,
        {
          message:
            `QQ 音乐搜索失败: ${
              error?.message ||
              '未知错误'
            }`
        }
      )
    }

    return c.json(
      data.map(
        (x) => {
          return {
            title:
              x.name,

            author:
              Array.isArray(
                x.artist
              )
                ? x.artist.join(
                    ' / '
                  )
                : '',

            url:
              `${baseUrl}/api?server=tencent&type=url&id=${encodeURIComponent(
                x.url_id
              )}&auth=${auth(
                'tencent',
                'url',
                x.url_id,
                token
              )}`,

            pic:
              `${baseUrl}/api?server=tencent&type=pic&id=${encodeURIComponent(
                x.pic_id
              )}&auth=${auth(
                'tencent',
                'pic',
                x.pic_id,
                token
              )}`,

            lrc:
              `${baseUrl}/api?server=tencent&type=lrc&id=${encodeURIComponent(
                x.lyric_id
              )}&auth=${auth(
                'tencent',
                'lrc',
                x.lyric_id,
                token
              )}`
          }
        }
      )
    )
  }

  // ----------------------------------------------------------
  // 5. 普通 Meting API
  // ----------------------------------------------------------

  const cacheKey =
    `${server}/${type}/${id}`

  let data =
    cache.get(
      cacheKey
    )

  if (
    data === undefined
  ) {
    c.header(
      'x-cache',
      'miss'
    )

    const meting =
      new Meting(
        server
      )

    // 网易云 EAPI
    patchNeteaseEapiEncrypt(
      meting
    )

    meting.format(
      true
    )

    // --------------------------------------------------------
    // Cookie
    // --------------------------------------------------------

    const referrer =
      c.req.header(
        'referer'
      )

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
        meting.cookie(
          cookie
        )
      }
    }

    // --------------------------------------------------------
    // 调用 Meting
    // --------------------------------------------------------

    const method =
      METING_METHODS[type]

    let response

    try {
      response =
        await meting[method](
          id
        )
    } catch (error) {
      console.error(
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

    // --------------------------------------------------------
    // JSON 解析
    // --------------------------------------------------------

    try {
      data =
        JSON.parse(
          response
        )
    } catch (error) {
      console.error(
        'JSON 解析失败:',
        error,
        response
      )

      throw new HTTPException(
        500,
        {
          message:
            '上游 API 返回格式异常'
        }
      )
    }

    // --------------------------------------------------------
    // 缓存
    // --------------------------------------------------------

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
    c.header(
      'x-cache',
      'hit'
    )
  }

  // ----------------------------------------------------------
  // 6. 音乐 URL
  // ----------------------------------------------------------

  if (
    type === 'url'
  ) {
    let url =
      data.url

    if (!url) {
      return c.body(
        null,
        404
      )
    }

    // 网易云
    if (
      server === 'netease'
    ) {
      url =
        url
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

      if (
        url.includes(
          'vuutv='
        )
      ) {
        const tempUrl =
          new URL(url)

        tempUrl.search =
          ''

        url =
          tempUrl.toString()
      }
    }

    // QQ 音乐
    if (
      server === 'tencent'
    ) {
      url =
        url
          .replace(
            'http://',
            'https://'
          )
          .replace(
            '://ws.stream.qqmusic.qq.com',
            '://dl.stream.qqmusic.qq.com'
          )
    }

    // 百度
    if (
      server === 'baidu'
    ) {
      url =
        url.replace(
          'http://zhangmenshiting.qianqian.com',
          'https://gss3.baidu.com/y0s1hSulBw92lNKgpU_Z2jR7b2w6buu'
        )
    }

    return c.redirect(
      url
    )
  }

  // ----------------------------------------------------------
  // 7. 图片
  // ----------------------------------------------------------

  if (
    type === 'pic'
  ) {
    const url =
      data.url

    if (!url) {
      return c.body(
        null,
        404
      )
    }

    return c.redirect(
      url
    )
  }

  // ----------------------------------------------------------
  // 8. 歌词
  // ----------------------------------------------------------

  if (
    type === 'lrc'
  ) {
    return c.text(
      lyricFormat(
        data.lyric,
        data.tlyric ||
          ''
      )
    )
  }

  // ----------------------------------------------------------
  // 9. 搜索 / 歌曲 / 专辑 / 歌手 / 歌单
  // ----------------------------------------------------------

  return c.json(
    data.map(
      (x) => {
        return {
          title:
            x.name,

          author:
            Array.isArray(
              x.artist
            )
              ? x.artist.join(
                  ' / '
                )
              : '',

          url:
            `${baseUrl}/api?server=${server}&type=url&id=${encodeURIComponent(
              x.url_id
            )}&auth=${auth(
              server,
              'url',
              x.url_id,
              token
            )}`,

          pic:
            `${baseUrl}/api?server=${server}&type=pic&id=${encodeURIComponent(
              x.pic_id
            )}&auth=${auth(
              server,
              'pic',
              x.pic_id,
              token
            )}`,

          lrc:
            `${baseUrl}/api?server=${server}&type=lrc&id=${encodeURIComponent(
              x.lyric_id
            )}&auth=${auth(
              server,
              'lrc',
              x.lyric_id,
              token
            )}`
        }
      }
    )
  )
}

// ============================================================
// 鉴权
// ============================================================

const auth = (
  server,
  type,
  id,
  token
) => {
  return hashjs
    .hmac(
      hashjs.sha1,
      token
    )
    .update(
      `${server}${type}${id}`
    )
    .digest(
      'hex'
    )
}