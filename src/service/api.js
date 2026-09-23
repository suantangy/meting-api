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
// QQ 音乐公共请求头
// ============================================================

const QQ_HEADERS = {
  'Content-Type': 'application/json',
  'Referer': 'https://y.qq.com/',
  'Origin': 'https://y.qq.com',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
}

// ============================================================
// QQ Cookie 解析
// ============================================================

const parseTencentCookie = (cookie = '') => {
  const result = {}

  for (const item of cookie.split(';')) {
    const index = item.indexOf('=')

    if (index === -1) {
      continue
    }

    const key =
      item.slice(0, index).trim()

    const value =
      item.slice(index + 1).trim()

    if (key) {
      result[key] = value
    }
  }

  return result
}

// ============================================================
// QQ Music zzc 签名
//
// 不新增 npm 依赖。
// 使用项目现有 hash.js 的 SHA1。
// ============================================================

const tencentZzcSign = (payload) => {
  const hash =
    hashjs
      .sha1()
      .update(payload)
      .digest('hex')
      .toUpperCase()

  // QQ Music zzc 第一段
  const part1Indexes = [
    23,
    14,
    6,
    36,
    16,
    40,
    7,
    19
  ]

  // QQ Music zzc 第二段
  const part2Indexes = [
    16,
    1,
    32,
    12,
    19,
    27,
    8,
    5
  ]

  // QQ Music zzc 20 字节混淆表
  const scramble = [
    89,
    39,
    179,
    150,
    218,
    82,
    58,
    252,
    177,
    52,
    186,
    123,
    120,
    64,
    242,
    133,
    143,
    161,
    121,
    179
  ]

  const part1 =
    part1Indexes
      .filter(
        (index) =>
          index < hash.length
      )
      .map(
        (index) =>
          hash[index]
      )
      .join('')

  const part2 =
    part2Indexes
      .filter(
        (index) =>
          index < hash.length
      )
      .map(
        (index) =>
          hash[index]
      )
      .join('')

  const bytes =
    new Uint8Array(20)

  for (
    let i = 0;
    i < 20;
    i++
  ) {
    const source =
      parseInt(
        hash.slice(
          i * 2,
          i * 2 + 2
        ),
        16
      )

    bytes[i] =
      scramble[i] ^ source
  }

  let binary = ''

  for (
    const byte of bytes
  ) {
    binary +=
      String.fromCharCode(byte)
  }

  const encoded =
    btoa(binary)
      .replace(
        /[\/\\+=]/g,
        ''
      )

  return (
    `zzc${part1}${encoded}${part2}`
  ).toLowerCase()
}

// ============================================================
// QQ Music 搜索
// ============================================================

const tencentSearch = async (
  keyword
) => {
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

  const response =
    await fetch(
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

        body:
          JSON.stringify(
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
      JSON.parse(
        responseText
      )
  } catch {
    throw new Error(
      `QQ 搜索返回非 JSON: ${responseText.slice(0, 500)}`
    )
  }

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
        Array.isArray(
          song.singer
        )
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

        media_mid:
          song.file?.media_mid ||
          song.media_mid ||
          song.strMediaMid ||
          '',

        song_id:
          song.id ||
          '',

        source:
          'tencent'
      }
    }
  )
}

// ============================================================
// QQ 音乐歌曲详情
//
// songmid → media_mid
// ============================================================

const tencentSongDetail = async (
  songmid,
  cookie = ''
) => {
  const url =
    'https://u.y.qq.com/cgi-bin/musicu.fcg'

  const payload = {
    comm: {
      ct: 24,
      cv: 4747474,
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq.json',
      needNewCode: 1,
      uin: '0'
    },

    songinfo: {
      method:
        'get_song_detail_yqq',

      module:
        'music.pf_song_detail_svr',

      param: {
        song_mid:
          songmid,

        song_id:
          0
      }
    }
  }

  const headers = {
    ...QQ_HEADERS
  }

  if (cookie) {
    headers.Cookie =
      cookie
  }

  const response =
    await fetch(
      url,
      {
        method: 'POST',
        headers,
        body:
          JSON.stringify(
            payload
          )
      }
    )

  const text =
    await response.text()

  if (!response.ok) {
    throw new Error(
      `QQ 歌曲详情 HTTP ${response.status}: ${text.slice(0, 500)}`
    )
  }

  let json

  try {
    json =
      JSON.parse(text)
  } catch {
    throw new Error(
      `QQ 歌曲详情返回非 JSON: ${text.slice(0, 500)}`
    )
  }

  const track =
    json?.songinfo?.data?.track_info ||
    json?.songinfo?.data?.trackInfo

  if (!track) {
    throw new Error(
      `QQ 歌曲详情缺少 track_info: ${JSON.stringify(json).slice(0, 1500)}`
    )
  }

  const mediaMid =
    track?.file?.media_mid ||
    track?.file?.strMediaMid ||
    track?.media_mid ||
    track?.strMediaMid ||
    ''

  if (!mediaMid) {
    throw new Error(
      `QQ 歌曲详情没有 media_mid: ${JSON.stringify(track).slice(0, 2000)}`
    )
  }

  return {
    songmid:
      track.mid ||
      songmid,

    media_mid:
      mediaMid,

    songid:
      track.id ||
      ''
  }
}

// ============================================================
// QQ Music VKEY
//
// 当前使用：
// musics.fcg?sign=xxx
// +
// vkey.GetVkeyServer
// +
// CgiGetVkey
// ============================================================

const tencentVkey = async (
  songmid,
  mediaMid,
  quality,
  cookie = '',
  uin = '0'
) => {
  const guid =
    String(
      Math.floor(
        1000000000 +
        Math.random() *
          8999999999
      )
    )

  let filename

  if (
    quality === 'M800'
  ) {
    filename =
      `M800${mediaMid}.mp3`
  } else if (
    quality === 'M500'
  ) {
    filename =
      `M500${mediaMid}.mp3`
  } else {
    filename =
      `C400${mediaMid}.m4a`
  }

  const payload = {
    comm: {
      cv: 4747474,
      ct: 24,
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq.json',
      needNewCode: 1,
      uin:
        String(
          uin || '0'
        ),

      g_tk_new_20200303:
        5381,

      g_tk:
        5381
    },

    req_1: {
      module:
        'vkey.GetVkeyServer',

      method:
        'CgiGetVkey',

      param: {
        filename: [
          filename
        ],

        guid,

        songmid: [
          songmid
        ],

        songtype: [
          0
        ],

        uin:
          String(
            uin || '0'
          ),

        loginflag:
          1,

        platform:
          '20'
      }
    }
  }

  const body =
    JSON.stringify(
      payload
    )

  // ==========================================================
  // 关键：
  // sign 针对实际 POST body 计算
  // ==========================================================

  const sign =
    tencentZzcSign(
      body
    )

  const url =
    `https://u.y.qq.com/cgi-bin/musics.fcg?_=${Date.now()}&sign=${encodeURIComponent(
      sign
    )}`

  const headers = {
    ...QQ_HEADERS
  }

  if (cookie) {
    headers.Cookie =
      cookie
  }

  const response =
    await fetch(
      url,
      {
        method: 'POST',

        headers,

        body
      }
    )

  const text =
    await response.text()

  if (!response.ok) {
    throw new Error(
      `QQ VKEY HTTP ${response.status}: ${text.slice(0, 500)}`
    )
  }

  let json

  try {
    json =
      JSON.parse(text)
  } catch {
    throw new Error(
      `QQ VKEY 返回非 JSON: ${text.slice(0, 1000)}`
    )
  }

  const result =
    json?.req_1

  if (!result) {
    throw new Error(
      `QQ VKEY 缺少 req_1: ${JSON.stringify(json).slice(0, 1500)}`
    )
  }

  const code =
    result.code

  if (
    code !== undefined &&
    Number(code) !== 0
  ) {
    throw new Error(
      `QQ VKEY code=${code}: ${JSON.stringify(result).slice(0, 1500)}`
    )
  }

  const data =
    result?.data

  const list =
    data?.midurlinfo

  if (
    !Array.isArray(list) ||
    !list.length
  ) {
    throw new Error(
      `QQ VKEY 没有 midurlinfo: ${JSON.stringify(result).slice(0, 2500)}`
    )
  }

  const item =
    list.find(
      (x) =>
        x?.purl ||
        x?.wifiurl
    )

  if (!item) {
    const resultCode =
      list[0]?.result

    throw new Error(
      `QQ ${quality} 未取得播放地址` +
      (
        resultCode !== undefined
          ? `，result=${resultCode}`
          : ''
      ) +
      `: ${JSON.stringify(list).slice(0, 2500)}`
    )
  }

  let playUrl =
    item.purl ||
    item.wifiurl ||
    ''

  if (!playUrl) {
    throw new Error(
      `QQ ${quality} 返回空播放地址`
    )
  }

  // ==========================================================
  // QQ 有些情况下返回相对路径
  // ==========================================================

  if (
    playUrl.startsWith('/')
  ) {
    playUrl =
      'https://dl.stream.qqmusic.qq.com' +
      playUrl
  }

  if (
    playUrl.startsWith(
      'http://'
    )
  ) {
    playUrl =
      playUrl.replace(
        'http://',
        'https://'
      )
  }

  return {
    url:
      playUrl,

    filename:
      item.filename ||
      filename,

    quality,

    vkey:
      item.vkey ||
      '',

    guid,

    result:
      item.result,

    raw:
      json
  }
}

// ============================================================
// QQ Music 播放地址
//
// songmid
// ↓
// song detail
// ↓
// media_mid
// ↓
// Cookie
// ↓
// zzc
// ↓
// CgiGetVkey
// ↓
// M800
// ↓
// M500
// ↓
// C400
// ============================================================

const tencentGetUrl = async (
  songmid,
  env
) => {
  if (!songmid) {
    throw new Error(
      '缺少 QQ songmid'
    )
  }

  // ==========================================================
  // 读取已经配置好的 Cookie
  // ==========================================================

  let cookie = ''

  try {
    cookie =
      await readCookieAsync(
        'tencent',
        env
      )
  } catch (error) {
    console.error(
      '读取 QQ Cookie 失败:',
      error
    )
  }

  // ==========================================================
  // 如果 readCookieAsync 没有取到，
  // 直接尝试 Secret。
  //
  // 这样兼容不同版本的 cookie.js。
  // ==========================================================

  if (
    !cookie &&
    env?.METING_COOKIE_TENCENT
  ) {
    cookie =
      env.METING_COOKIE_TENCENT
  }

  if (!cookie) {
    throw new Error(
      '未读取到 METING_COOKIE_TENCENT'
    )
  }

  // ==========================================================
  // 解析 Cookie
  // ==========================================================

  const cookies =
    parseTencentCookie(
      cookie
    )

  const uin =
    cookies.uin ||
    cookies.qlogin_uid ||
    '0'

  const qmKeyst =
    cookies.qm_keyst ||
    cookies.qqmusic_key ||
    ''

  if (!qmKeyst) {
    throw new Error(
      'Cookie 中没有 qm_keyst / qqmusic_key'
    )
  }

  // ==========================================================
  // 获取 media_mid
  // ==========================================================

  let detail

  try {
    detail =
      await tencentSongDetail(
        songmid,
        cookie
      )
  } catch (error) {
    throw new Error(
      `QQ 获取歌曲详情失败: ${
        error?.message ||
        '未知错误'
      }`
    )
  }

  const mediaMid =
    detail.media_mid

  if (!mediaMid) {
    throw new Error(
      `QQ 未取得 media_mid，songmid=${songmid}`
    )
  }

  // ==========================================================
  // 依次尝试不同音质
  // ==========================================================

  const qualities = [
    'M800',
    'M500',
    'C400'
  ]

  const errors = []

  for (
    const quality of qualities
  ) {
    try {
      const result =
        await tencentVkey(
          songmid,
          mediaMid,
          quality,
          cookie,
          uin
        )

      if (
        result?.url
      ) {
        return result
      }
    } catch (error) {
      console.error(
        `QQ ${quality} 获取失败:`,
        error
      )

      errors.push(
        `${quality}: ${
          error?.message ||
          '未知错误'
        }`
      )
    }
  }

  throw new Error(
    `QQ 音乐无法获取播放地址；${errors.join(
      ' | '
    )}`
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
    new URL(
      c.req.url
    ).origin

  const token =
    config.meting.token ||
    'token'

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

  // ==========================================================
  // 参数校验
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

  // ==========================================================
  // 鉴权
  // ==========================================================

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

  // ==========================================================
  // QQ 搜索
  // ==========================================================

  if (
    server === 'tencent' &&
    type === 'search'
  ) {
    let data

    try {
      data =
        await tencentSearch(
          id
        )
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

  // ==========================================================
  // QQ Music URL
  //
  // 完全绕过 @meting/core
  // ==========================================================

  if (
    server === 'tencent' &&
    type === 'url'
  ) {
    try {
      const result =
        await tencentGetUrl(
          id,
          c.env
        )

      return c.redirect(
        result.url
      )
    } catch (error) {
      console.error(
        'QQ 音乐播放地址获取失败:',
        error
      )

      throw new HTTPException(
        404,
        {
          message:
            `QQ 音乐播放地址获取失败: ${
              error?.message ||
              '未知错误'
            }`
        }
      )
    }
  }

  // ==========================================================
  // 普通 Meting API
  // ==========================================================

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

    patchNeteaseEapiEncrypt(
      meting
    )

    meting.format(
      true
    )

    // ========================================================
    // Cookie
    // ========================================================

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

    // ========================================================
    // 调用 Meting
    // ========================================================

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

    // ========================================================
    // JSON 解析
    // ========================================================

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

  // ==========================================================
  // 普通音乐 URL
  // ==========================================================

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

    // --------------------------------------------------------
    // 网易云
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // 百度
    // --------------------------------------------------------

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

  // ==========================================================
  // 图片
  // ==========================================================

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

  // ==========================================================
  // 歌词
  // ==========================================================

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

  // ==========================================================
  // 搜索 / 歌曲 / 专辑 / 歌手 / 歌单
  // ==========================================================

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