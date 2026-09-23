import Meting from '@meting/core'
import aesjs from 'aes-js'
import { createHash } from 'node:crypto'
import hashjs from 'hash.js'
import { HTTPException } from 'hono/http-exception'
import { config } from '../config/index.js'
import { parseLyric, unescape } from '../utils/lyric.js'
import {
  readCookieAsync,
  setCookieAsync,
  clearCookieAsync
} from '../utils/cookie.js'
import { LRUCache } from 'lru-cache'

const METING_METHODS = new Set([
  'search',
  'song',
  'album',
  'artist',
  'playlist',
  'lrc',
  'url',
  'pic'
])

const QQ_HEADERS = {
  'Content-Type': 'application/json',
  'Referer': 'https://y.qq.com/',
  'Origin': 'https://y.qq.com',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
}

/* =========================================================
 * 基础工具
 * ========================================================= */

const parseTencentCookie = (cookie = '') => {
  const result = {}

  String(cookie)
    .split(';')
    .forEach(item => {
      const index = item.indexOf('=')

      if (index <= 0) return

      const key = item.slice(0, index).trim()
      const value = item.slice(index + 1).trim()

      if (key) {
        result[key] = value
      }
    })

  return result
}

/*
 * QQ 音乐认证信息
 *
 * 优先级：
 *   authst
 *   strAuthst
 *   str_authst
 *   psrf_authst
 *
 * 如果没有独立 authst，则兼容：
 *   qqmusic_key
 *   qm_keyst
 *
 * 注意：
 * qqmusic_key / qm_keyst 不等同于标准 authst，
 * 这里只作为兼容回退，不把它们标记为真正 authst。
 */
const getTencentAuth = (cookie = '') => {
  const cookies = parseTencentCookie(cookie)

  const uin =
    cookies.uin ||
    cookies.wxuin ||
    cookies.qlogin_uid ||
    cookies.qqmusic_uin ||
    '0'

  const authst =
    cookies.authst ||
    cookies.strAuthst ||
    cookies.str_authst ||
    cookies.psrf_authst ||
    ''

  const qqmusicKey = cookies.qqmusic_key || ''
  const qmKeyst = cookies.qm_keyst || ''

  const loginType =
    cookies.login_type ||
    cookies.loginType ||
    cookies.tmeLoginType ||
    '1'

  return {
    uin: String(uin),

    // 真正 authst 优先
    authst: authst || qqmusicKey || qmKeyst,

    // 是否真的存在 authst / strAuthst
    hasRealAuthst: Boolean(authst),

    // 兼容字段
    hasQqmusicKey: Boolean(qqmusicKey),
    hasQmKeyst: Boolean(qmKeyst),

    loginType: String(loginType)
  }
}

const getTencentCookie = async env => {
  let cookie = ''

  try {
    cookie = await readCookieAsync('tencent', env)
  } catch {}

  if (!cookie && env?.METING_COOKIE_TENCENT) {
    cookie = env.METING_COOKIE_TENCENT
  }

  return cookie || ''
}

/*
 * QQ 新版 zzc 签名
 *
 * 这里只用于 CgiGetEVkey。
 * 如果 QQ 后续再次调整签名机制，需要单独更新。
 */
const tencentZzcSign = payload => {
  const hash = hashjs
    .sha1()
    .update(payload)
    .digest('hex')
    .toUpperCase()

  const part1Indexes = [23, 14, 6, 36, 16, 40, 7, 19]
  const part2Indexes = [16, 1, 32, 12, 19, 27, 8, 5]

  const scramble = [
    89, 39, 179, 150, 218,
    82, 58, 252, 177, 52,
    186, 123, 120, 64, 242,
    133, 143, 161, 121, 179
  ]

  const part1 = part1Indexes
    .map(i => hash[i] || '')
    .join('')

  const part2 = part2Indexes
    .map(i => hash[i] || '')
    .join('')

  let encoded = ''

  for (let i = 0; i < scramble.length; i++) {
    const value = scramble[i] % hash.length
    encoded += hash[value] || ''
  }

  return `zzc${part1}${encoded}${part2}`.toLowerCase()
}

/* =========================================================
 * QQ 搜索
 * ========================================================= */

const tencentSearch = async keyword => {
  const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg'

  const payload = {
    req_1: {
      method: 'DoSearchForQQMusicDesktop',
      module: 'music.search.SearchCgiService',
      param: {
        num_per_page: 30,
        page_num: 1,
        query: keyword,
        search_type: 0
      }
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: QQ_HEADERS,
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    throw new Error(`QQ 搜索失败：HTTP ${response.status}`)
  }

  const json = await response.json()

  const list =
    json?.req_1?.data?.body?.song?.list ||
    []

  return list.map(song => {
    const singers = Array.isArray(song.singer)
      ? song.singer
      : []

    const artist = singers
      .map(item => item?.name || '')
      .filter(Boolean)
      .join(' / ')

    const songmid =
      song.mid ||
      String(song.id || '')

    const mediaMid =
      song?.file?.media_mid ||
      song?.media_mid ||
      song?.strMediaMid ||
      ''

    const albumMid =
      song?.album?.mid ||
      ''

    return {
      id: songmid,
      name: song.name || '',
      artist,
      album: song?.album?.name || '',
      pic_id: albumMid,
      url_id: songmid,
      lyric_id: songmid,
      media_mid: mediaMid,
      song_id: song.id || '',
      source: 'tencent'
    }
  })
}

/* =========================================================
 * QQ 歌曲详情
 * ========================================================= */

const tencentSongDetail = async (songmid, cookie) => {
  const auth = getTencentAuth(cookie)

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

      // 不再固定为 0
      uin: auth.uin
    },

    songinfo: {
      method: 'get_song_detail_yqq',
      module: 'music.pf_song_detail_svr',
      param: {
        song_mid: songmid,
        song_id: 0
      }
    }
  }

  const response = await fetch(
    'https://u.y.qq.com/cgi-bin/musicu.fcg',
    {
      method: 'POST',
      headers: QQ_HEADERS,
      body: JSON.stringify(payload)
    }
  )

  if (!response.ok) {
    throw new Error(
      `QQ 歌曲详情请求失败：HTTP ${response.status}`
    )
  }

  const json = await response.json()

  const track =
    json?.songinfo?.data?.track_info

  if (!track) {
    throw new Error(
      'QQ 歌曲详情没有 track_info'
    )
  }

  const mediaMid =
    track?.file?.media_mid ||
    track?.media_mid ||
    track?.strMediaMid ||
    ''

  if (!mediaMid) {
    throw new Error(
      'QQ 歌曲详情没有 media_mid'
    )
  }

  return {
    songmid,
    media_mid: mediaMid,
    song_id: track.id || '',
    name: track.name || '',
    title: track.title || '',
    singer: Array.isArray(track.singer)
      ? track.singer.map(x => x.name).join(' / ')
      : '',
    album: track?.album?.name || ''
  }
}

/* =========================================================
 * QQ CgiGetVkey
 * ========================================================= */

const tencentVkey = async (
  songmid,
  mediaMid,
  quality,
  cookie
) => {
  const auth = getTencentAuth(cookie)

  const prefixMap = {
    M800: 'M800',
    M500: 'M500',
    C400: 'C400'
  }

  const prefix =
    prefixMap[quality] || 'M800'

  const filename =
    `${prefix}${mediaMid}.mp3`

  const guid =
    String(
      Date.now() +
      Math.floor(Math.random() * 100000)
    )

  const uin = auth.uin
  const musicKey = auth.authst

  const payload = {
    comm: {
      cv: 13020508,
      v: 13020508,
      ct: '11',
      tmeAppID: 'qqmusic',
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',

      uid: uin,

      QIMEI36:
        '0000000000000000000000000000000000000000000000',

      // 登录认证
      qq: uin,
      authst: musicKey,
      tmeLoginType: auth.loginType
    },

    req_1: {
      method: 'UrlGetVkey',
      module: 'music.vkey.GetVkey',
      param: {
        filename: [filename],
        guid,
        songmid: [songmid],
        songtype: [0]
      }
    }
  }

  const response = await fetch(
    'https://u.y.qq.com/cgi-bin/musicu.fcg',
    {
      method: 'POST',
      headers: QQ_HEADERS,
      body: JSON.stringify(payload)
    }
  )

  if (!response.ok) {
    throw new Error(
      `QQ VKEY ${quality} 请求失败：HTTP ${response.status}`
    )
  }

  const json = await response.json()

  const data =
    json?.req_1?.data

  const list =
    data?.midurlinfo ||
    data?.midurlinfo_list ||
    []

  const item =
    Array.isArray(list)
      ? list.find(x =>
          x?.purl ||
          x?.wifiurl
        )
      : null

  const purl =
    item?.purl ||
    item?.wifiurl ||
    ''

  if (!purl) {
    const result =
      data?.result ??
      json?.req_1?.code ??
      ''

    throw new Error(
      `QQ VKEY ${quality} 无播放地址，result=${result}: ${JSON.stringify(list).slice(0, 1500)}`
    )
  }

  return purl.startsWith('http')
    ? purl
    : `https://isure.stream.qqmusic.qq.com/${purl}`
}

/* =========================================================
 * QQ CgiGetEVkey
 * ========================================================= */

const tencentEVkey = async (
  songmid,
  mediaMid,
  quality,
  cookie
) => {
  const auth = getTencentAuth(cookie)

  const prefixMap = {
    M800: 'M800',
    M500: 'M500',
    C400: 'C400'
  }

  const prefix =
    prefixMap[quality] || 'M800'

  const filename =
    `${prefix}${mediaMid}.mp3`

  const guid =
    String(
      Date.now() +
      Math.floor(Math.random() * 100000)
    )

  const common = {
    cv: 13020508,
    v: 13020508,
    ct: '19',
    tmeAppID: 'qqmusic',
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    uid: auth.uin,

    QIMEI36:
      '0000000000000000000000000000000000000000000000'
  }

  /*
   * 关键：
   * 只要有认证信息，就把 uin/authst/loginType
   * 一起传给 EVKEY。
   */
  if (
    auth.uin !== '0' &&
    auth.authst
  ) {
    common.qq = auth.uin
    common.authst = auth.authst
    common.tmeLoginType = auth.loginType
  }

  const payload = {
    comm: common,

    req_1: {
      method: 'CgiGetEVkey',
      module: 'music.vkey.GetEVkey',

      param: {
        filename: [filename],
        guid,

        songmid: [songmid],
        songtype: [0],

        // 新增真实 uin
        uin: auth.uin
      }
    }
  }

  const body = JSON.stringify(payload)

  const sign =
    tencentZzcSign(body)

  const response = await fetch(
    `https://u.y.qq.com/cgi-bin/musics.fcg?sign=${encodeURIComponent(sign)}`,
    {
      method: 'POST',
      headers: QQ_HEADERS,
      body
    }
  )

  if (!response.ok) {
    throw new Error(
      `QQ EVKEY ${quality} 请求失败：HTTP ${response.status}`
    )
  }

  const json = await response.json()

  const data =
    json?.req_1?.data

  const list =
    data?.midurlinfo ||
    data?.midurlinfo_list ||
    []

  const item =
    Array.isArray(list)
      ? list.find(x =>
          x?.purl ||
          x?.wifiurl
        )
      : null

  const purl =
    item?.purl ||
    item?.wifiurl ||
    ''

  if (!purl) {
    const result =
      data?.result ??
      json?.req_1?.code ??
      ''

    throw new Error(
      `QQ EVKEY ${quality} 无播放地址，result=${result}: ${JSON.stringify(list).slice(0, 1500)}`
    )
  }

  return purl.startsWith('http')
    ? purl
    : `https://isure.stream.qqmusic.qq.com/${purl}`
}

/* =========================================================
 * QQ 状态检测
 * ========================================================= */

const tencentStatus = async env => {
  const cookie =
    await getTencentCookie(env)

  if (!cookie) {
    return {
      ok: false,
      cookie_configured: false,
      uin: false,
      wxuin: false,
      qm_keyst: false,
      qqmusic_key: false,
      authst: false,
      authst_source: 'none',
      access_token: false,
      refresh_token: false,
      playback_key: false,

      message:
        '未读取到 METING_COOKIE_TENCENT'
    }
  }

  const cookies =
    parseTencentCookie(cookie)

  const auth =
    getTencentAuth(cookie)

  const hasMusicKey =
    Boolean(
      cookies.qm_keyst ||
      cookies.qqmusic_key
    )

  const hasRealAuthst =
    Boolean(
      auth.hasRealAuthst
    )

  let message =
    '已读取 QQ Cookie'

  if (hasRealAuthst) {
    message =
      '已检测到 authst/strAuthst，可继续测试 QQ EVKEY'
  } else if (hasMusicKey) {
    message =
      '未检测到独立 authst；当前仅检测到 qqmusic_key/qm_keyst，EVKEY 可能仍受播放授权限制'
  } else {
    message =
      '未检测到 authst、qqmusic_key 或 qm_keyst'
  }

  return {
    ok: true,

    cookie_configured: true,

    uin: Boolean(
      cookies.uin
    ),

    wxuin: Boolean(
      cookies.wxuin
    ),

    qm_keyst: Boolean(
      cookies.qm_keyst
    ),

    qqmusic_key: Boolean(
      cookies.qqmusic_key
    ),

    // 真正 authst 状态
    authst: hasRealAuthst,

    authst_source:
      hasRealAuthst
        ? 'authst/strAuthst'
        : hasMusicKey
          ? 'qqmusic_key/qm_keyst'
          : 'none',

    access_token: Boolean(
      cookies.access_token ||
      cookies.accessToken
    ),

    refresh_token: Boolean(
      cookies.refresh_token ||
      cookies.refreshToken
    ),

    /*
     * 这里只保留状态，不暴露任何实际 token。
     */
    playback_key: Boolean(
      cookies.playback_key ||
      cookies.playbackKey ||
      cookies.playback_token ||
      cookies.playbackToken ||
      cookies.strPlaybackKey ||
      cookies.str_playback_key
    ),

    message
  }
}

/* =========================================================
 * QQ EVKEY 测试
 * ========================================================= */

const tencentEVkeyTest = async (
  songmid,
  env
) => {
  const cookie =
    await getTencentCookie(env)

  if (!cookie) {
    throw new Error(
      '未配置 QQ Cookie'
    )
  }

  const detail =
    await tencentSongDetail(
      songmid,
      cookie
    )

  const qualities = [
    'M800',
    'M500',
    'C400'
  ]

  const results = []

  for (const quality of qualities) {
    try {
      const url =
        await tencentEVkey(
          songmid,
          detail.media_mid,
          quality,
          cookie
        )

      results.push({
        quality,
        ok: true,
        url
      })

      return {
        ok: true,
        songmid,
        media_mid:
          detail.media_mid,
        results
      }
    } catch (error) {
      results.push({
        quality,
        ok: false,
        error:
          error?.message ||
          String(error)
      })
    }
  }

  return {
    ok: false,
    songmid,
    media_mid:
      detail.media_mid,
    results
  }
}

/* =========================================================
 * QQ 播放地址
 * ========================================================= */

const tencentGetUrl = async (
  id,
  env
) => {
  const cookie =
    await getTencentCookie(env)

  if (!cookie) {
    throw new Error(
      '未配置 QQ Cookie'
    )
  }

  const detail =
    await tencentSongDetail(
      id,
      cookie
    )

  const qualities = [
    'M800',
    'M500',
    'C400'
  ]

  /*
   * 第一套：CgiGetVkey
   */
  for (const quality of qualities) {
    try {
      return await tencentVkey(
        id,
        detail.media_mid,
        quality,
        cookie
      )
    } catch {}
  }

  /*
   * 第二套：CgiGetEVkey
   */
  for (const quality of qualities) {
    try {
      return await tencentEVkey(
        id,
        detail.media_mid,
        quality,
        cookie
      )
    } catch {}
  }

  throw new Error(
    'QQ 音乐未取得可播放地址'
  )
}

/* =========================================================
 * URL / Pic / LRC 辅助
 * ========================================================= */

const getTencentPic = id => {
  return `https://y.qq.com/music/photo_new/T002R800x800M000${id}.jpg`
}

const getTencentLyric = async (
  id,
  cookie
) => {
  const auth =
    getTencentAuth(cookie)

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
      uin: auth.uin
    },

    lyric: {
      method: 'GetLyric',
      module: 'music.musichallSong.PlayLyricInfo',
      param: {
        songMID: id,
        songID: 0
      }
    }
  }

  const response = await fetch(
    'https://u.y.qq.com/cgi-bin/musicu.fcg',
    {
      method: 'POST',
      headers: QQ_HEADERS,
      body: JSON.stringify(payload)
    }
  )

  if (!response.ok) {
    throw new Error(
      `QQ 歌词请求失败：HTTP ${response.status}`
    )
  }

  const json =
    await response.json()

  const lyric =
    json?.lyric?.data?.lyric ||
    ''

  if (!lyric) {
    return ''
  }

  try {
    const decoded =
      aesjs.utils.utf8.fromBytes(
        Uint8Array.from(
          atob(lyric),
          c => c.charCodeAt(0)
        )
      )

    return decoded
  } catch {
    try {
      return decodeURIComponent(
        escape(atob(lyric))
      )
    } catch {
      return lyric
    }
  }
}

/* =========================================================
 * Meting 初始化
 * ========================================================= */

const createMeting = (server, env) => {
  return new Meting(server, {
    ...config?.[server],

    cookie: env?.METING_COOKIE_TENCENT || ''
  })
}

/* =========================================================
 * 主 API
 * ========================================================= */

export const api = async (
  c
) => {
  const server =
    c.req.query('server') ||
    'netease'

  const type =
    c.req.query('type') ||
    'search'

  const id =
    c.req.query('id') ||
    ''

  const keyword =
    c.req.query('name') ||
    c.req.query('keyword') ||
    ''

  const env =
    c.env || {}

  /*
   * QQ 状态
   */
  if (
    server === 'tencent' &&
    type === 'qqstatus'
  ) {
    return c.json(
      await tencentStatus(env)
    )
  }

  /*
   * QQ EVKEY 测试
   */
  if (
    server === 'tencent' &&
    type === 'evkey'
  ) {
    try {
      const result =
        await tencentEVkeyTest(
          id,
          env
        )

      return c.json(result)
    } catch (error) {
      return c.json(
        {
          ok: false,
          error:
            error?.message ||
            String(error)
        },
        400
      )
    }
  }

  /*
   * QQ 搜索
   */
  if (
    server === 'tencent' &&
    type === 'search'
  ) {
    try {
      const list =
        await tencentSearch(
          keyword
        )

      return c.json(list)
    } catch (error) {
      return c.json(
        {
          code: 500,
          message:
            error?.message ||
            String(error),
          data: []
        },
        500
      )
    }
  }

  /*
   * QQ 播放地址
   */
  if (
    server === 'tencent' &&
    type === 'url'
  ) {
    try {
      const url =
        await tencentGetUrl(
          id,
          env
        )

      return c.json({
        url
      })
    } catch (error) {
      return c.json(
        {
          code: 500,
          message:
            error?.message ||
            String(error),
          url: ''
        },
        500
      )
    }
  }

  /*
   * QQ 图片
   *
   * 如果传的是 album mid，
   * 使用 QQ 官方图片地址。
   */
  if (
    server === 'tencent' &&
    type === 'pic'
  ) {
    return c.json({
      url:
        getTencentPic(id)
    })
  }

  /*
   * QQ 歌词
   */
  if (
    server === 'tencent' &&
    type === 'lrc'
  ) {
    try {
      const cookie =
        await getTencentCookie(env)

      const lyric =
        await getTencentLyric(
          id,
          cookie
        )

      return c.json({
        lyric
      })
    } catch (error) {
      return c.json(
        {
          code: 500,
          message:
            error?.message ||
            String(error),
          lyric: ''
        },
        500
      )
    }
  }

  /*
   * 其他平台走 Meting
   */
  if (!METING_METHODS.has(type)) {
    throw new HTTPException(
      400,
      {
        message:
          `不支持的 type：${type}`
      }
    )
  }

  try {
    const meting =
      createMeting(
        server,
        env
      )

    let result

    switch (type) {
      case 'search':
        result =
          await meting.search(
            keyword
          )
        break

      case 'song':
        result =
          await meting.song(
            id
          )
        break

      case 'album':
        result =
          await meting.album(
            id
          )
        break

      case 'artist':
        result =
          await meting.artist(
            id
          )
        break

      case 'playlist':
        result =
          await meting.playlist(
            id
          )
        break

      case 'lrc':
        result =
          await meting.lyric(
            id
          )
        break

      case 'url':
        result =
          await meting.url(
            id
          )
        break

      case 'pic':
        result =
          await meting.pic(
            id
          )
        break

      default:
        throw new Error(
          `未知 type：${type}`
        )
    }

    return c.json(result)
  } catch (error) {
    console.error(
      'Meting API Error:',
      error
    )

    if (
      error instanceof HTTPException
    ) {
      throw error
    }

    return c.json(
      {
        code: 500,
        message:
          error?.message ||
          String(error)
      },
      500
    )
  }
}