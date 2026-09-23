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
// QQ Cookie
// ============================================================

const getTencentCookie = async (env) => {
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

  if (
    !cookie &&
    env?.METING_COOKIE_TENCENT
  ) {
    cookie =
      env.METING_COOKIE_TENCENT
  }

  return cookie || ''
}

// ============================================================
// QQ Music zzc 签名
// ============================================================

const tencentZzcSign = (payload) => {
  const hash =
    hashjs
      .sha1()
      .update(payload)
      .digest('hex')
      .toUpperCase()

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
        index =>
          index < 40
      )
      .map(
        index =>
          hash[index]
      )
      .join('')

  const part2 =
    part2Indexes
      .map(
        index =>
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
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
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
    song => {
      const singer =
        Array.isArray(
          song.singer
        )
          ? song.singer
          : []

      const artist =
        singer
          .map(
            x =>
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
// QQ VKEY 公共结果解析
// ============================================================

const parseTencentUrlResult = (
  json,
  rootKey
) => {
  const result =
    json?.[rootKey]

  if (!result) {
    throw new Error(
      `QQ VKEY 缺少 ${rootKey}: ${JSON.stringify(json).slice(0, 2000)}`
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
      x =>
        x?.purl ||
        x?.wifiurl
    )

  if (!item) {
    const resultCode =
      list[0]?.result

    throw new Error(
      `QQ 未取得播放地址` +
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

  if (
    playUrl.startsWith('/')
  ) {
    playUrl =
      'https://isure.stream.qqmusic.qq.com' +
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
      '',

    vkey:
      item.vkey ||
      '',

    ekey:
      item.ekey ||
      '',

    result:
      item.result,

    raw:
      json
  }
}

// ============================================================
// QQ VKEY
//
// 第一条路线：
// music.vkey.GetVkey.UrlGetVkey
//
// 注意：文件名使用 media_mid。
// ============================================================

const tencentVkey = async (
  songmid,
  mediaMid,
  quality,
  cookie = ''
) => {
  const guid =
    Array.from(
      { length: 32 },
      () =>
        Math.floor(
          Math.random() * 16
        ).toString(16)
    ).join('')

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

  const cookies =
    parseTencentCookie(
      cookie
    )

  const uin =
    cookies.uin ||
    cookies.wxuin ||
    cookies.qlogin_uid ||
    '0'

  const musicKey =
    cookies.qqmusic_key ||
    cookies.qm_keyst ||
    ''

  const payload = {
    comm: {
      cv: 13020508,
      v: 13020508,
      ct: '11',
      tmeAppID: 'qqmusic',
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      uid: '3931641530',

      qq:
        musicKey
          ? String(uin)
          : undefined,

      authst:
        musicKey ||
        undefined,

      tmeLoginType:
        musicKey
          ? String(
              cookies.login_type ||
              cookies.loginType ||
              cookies.tmeLoginType ||
              1
            )
          : undefined,

      QIMEI36:
        '6c9d3cd110abca9b16311cee10001e717614'
    },

    'music.vkey.GetVkey.UrlGetVkey': {
      module:
        'music.vkey.GetVkey',

      method:
        'UrlGetVkey',

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
        ]
      }
    }
  }

  for (
    const key of Object.keys(
      payload.comm
    )
  ) {
    if (
      payload.comm[key] ===
      undefined
    ) {
      delete payload.comm[key]
    }
  }

  const body =
    JSON.stringify(
      payload
    )

  const url =
    'https://u.y.qq.com/cgi-bin/musicu.fcg'

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
      `QQ VKEY HTTP ${response.status}: ${text.slice(0, 800)}`
    )
  }

  let json

  try {
    json =
      JSON.parse(text)
  } catch {
    throw new Error(
      `QQ VKEY 返回非 JSON: ${text.slice(0, 1200)}`
    )
  }

  const result =
    json?.[
      'music.vkey.GetVkey.UrlGetVkey'
    ]

  const list =
    result?.data?.midurlinfo

  if (
    !Array.isArray(list) ||
    !list.length
  ) {
    throw new Error(
      `QQ CgiGetVkey 没有 midurlinfo: ${JSON.stringify(result).slice(0, 2500)}`
    )
  }

  const item =
    list.find(
      x =>
        x?.purl ||
        x?.wifiurl
    )

  if (!item) {
    throw new Error(
      `QQ CgiGetVkey ${quality} 无播放地址，result=${list[0]?.result ?? 'unknown'}: ${JSON.stringify(list).slice(0, 2500)}`
    )
  }

  let playUrl =
    item.purl ||
    item.wifiurl ||
    ''

  if (
    playUrl.startsWith('/')
  ) {
    playUrl =
      'https://isure.stream.qqmusic.qq.com' +
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

    result:
      item.result,

    raw:
      json
  }
}

// ============================================================
// QQ EVKEY
//
// 第二条路线：
// music.vkey.GetEVkey.CgiGetEVkey
//
// 注意：文件名使用 media_mid。
// ============================================================

const tencentEVkey = async (
  songmid,
  mediaMid,
  quality,
  cookie = ''
) => {
  const guid =
    Array.from(
      { length: 32 },
      () =>
        Math.floor(
          Math.random() * 16
        ).toString(16)
    ).join('')

  let prefix
  let ext

  if (
    quality === 'M800'
  ) {
    prefix = 'M800'
    ext = '.mp3'
  } else if (
    quality === 'M500'
  ) {
    prefix = 'M500'
    ext = '.mp3'
  } else {
    prefix = 'C400'
    ext = '.m4a'
  }

  const filename =
    `${prefix}${mediaMid}${ext}`

  const cookies =
    parseTencentCookie(
      cookie
    )

  const uin =
    cookies.uin ||
    cookies.wxuin ||
    cookies.qlogin_uid ||
    '0'

  const musicKey =
    cookies.qqmusic_key ||
    cookies.qm_keyst ||
    ''

  const loginType =
    cookies.login_type ||
    cookies.loginType ||
    cookies.tmeLoginType ||
    '1'

  const common = {
    cv: 13020508,
    v: 13020508,
    ct: '19',
    tmeAppID: 'qqmusic',
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    uid: '3931641530',

    QIMEI36:
      '6c9d3cd110abca9b16311cee10001e717614'
  }

  if (
    uin !== '0' &&
    musicKey
  ) {
    common.qq =
      String(uin)

    common.authst =
      musicKey

    common.tmeLoginType =
      String(loginType)
  }

  const payload = {
    comm:
      common,

    'music.vkey.GetEVkey.CgiGetEVkey': {
      module:
        'music.vkey.GetEVkey',

      method:
        'CgiGetEVkey',

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
        ]
      }
    }
  }

  const body =
    JSON.stringify(
      payload
    )

  const sign =
    tencentZzcSign(
      body
    )

  const url =
    `https://u.y.qq.com/cgi-bin/musics.fcg?sign=${encodeURIComponent(
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
      `QQ EVKEY HTTP ${response.status}: ${text.slice(0, 1000)}`
    )
  }

  let json

  try {
    json =
      JSON.parse(text)
  } catch {
    throw new Error(
      `QQ EVKEY 返回非 JSON: ${text.slice(0, 1500)}`
    )
  }

  const result =
    json?.[
      'music.vkey.GetEVkey.CgiGetEVkey'
    ]

  if (!result) {
    throw new Error(
      `QQ EVKEY 缺少返回节点: ${JSON.stringify(json).slice(0, 2500)}`
    )
  }

  const list =
    result?.data?.midurlinfo

  if (
    !Array.isArray(list) ||
    !list.length
  ) {
    throw new Error(
      `QQ EVKEY 没有 midurlinfo: ${JSON.stringify(result).slice(0, 3000)}`
    )
  }

  const item =
    list.find(
      x =>
        x?.purl ||
        x?.wifiurl
    )

  if (!item) {
    const resultCode =
      list[0]?.result

    throw new Error(
      `QQ EVKEY ${quality} 无播放地址` +
      (
        resultCode !== undefined
          ? `，result=${resultCode}`
          : ''
      ) +
      `: ${JSON.stringify(list).slice(0, 3000)}`
    )
  }

  let playUrl =
    item.purl ||
    item.wifiurl ||
    ''

  if (
    playUrl.startsWith('/')
  ) {
    playUrl =
      'https://isure.stream.qqmusic.qq.com' +
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

    ekey:
      item.ekey ||
      '',

    result:
      item.result,

    raw:
      json
  }
}

// ============================================================
// QQ 状态诊断
//
// 不返回 Cookie / token / QQ号原文。
// ============================================================

const tencentStatus = async (
  env
) => {
  const cookie =
    await getTencentCookie(
      env
    )

  if (!cookie) {
    return {
      ok: false,
      cookie_configured: false,
      uin: false,
      wxuin: false,
      qm_keyst: false,
      qqmusic_key: false,
      access_token: false,
      refresh_token: false,
      playback_key: false,
      message:
        '未读取到 METING_COOKIE_TENCENT'
    }
  }

  const cookies =
    parseTencentCookie(
      cookie
    )

  const hasUin =
    Boolean(
      cookies.uin ||
      cookies.wxuin ||
      cookies.qlogin_uid
    )

  const hasMusicKey =
    Boolean(
      cookies.qm_keyst ||
      cookies.qqmusic_key
    )

  const hasAccessToken =
    Boolean(
      cookies.psrf_qqaccess_token ||
      cookies.wxaccess_token ||
      cookies.access_token
    )

  const hasRefreshToken =
    Boolean(
      cookies.psrf_qqrefresh_token ||
      cookies.wxrefresh_token ||
      cookies.refresh_token
    )

  const playbackCandidates = [
    'playback_key',
    'playbackKey',
    'qqCookiePlaybackKey',
    'qqmusic_playback_key',
    'qm_playback_key',
    'psrf_playback_key',
    'play_key',
    'playkey',
    'authst'
  ]

  const playbackKey =
    playbackCandidates.some(
      key =>
        Boolean(
          cookies[key]
        )
    )

  return {
    ok: true,

    cookie_configured:
      true,

    uin:
      hasUin,

    wxuin:
      Boolean(
        cookies.wxuin
      ),

    qm_keyst:
      Boolean(
        cookies.qm_keyst
      ),

    qqmusic_key:
      Boolean(
        cookies.qqmusic_key
      ),

    access_token:
      hasAccessToken,

    refresh_token:
      hasRefreshToken,

    playback_key:
      playbackKey,

    message:
      playbackKey
        ? '检测到播放相关票据候选字段'
        : '未检测到独立播放票据候选字段；如果 VKEY 仍返回 104003，通常属于 QQ 播放授权限制'
  }
}

// ============================================================
// QQ EVKEY 独立测试
//
// 用法：
// /api?server=tencent&type=evkey&id=歌曲songmid
//
// 例如：
// /api?server=tencent&type=evkey&id=0039MnYb0qxYhV
//
// 不经过普通 url 流程，直接测试 EVKEY。
// ============================================================

const tencentEVkeyTest = async (
  songmid,
  env
) => {
  if (!songmid) {
    throw new Error(
      '缺少 QQ songmid'
    )
  }

  const cookie =
    await getTencentCookie(
      env
    )

  if (!cookie) {
    throw new Error(
      '未读取到 METING_COOKIE_TENCENT'
    )
  }

  const cookies =
    parseTencentCookie(
      cookie
    )

  const hasMusicKey =
    Boolean(
      cookies.qqmusic_key ||
      cookies.qm_keyst
    )

  if (!hasMusicKey) {
    throw new Error(
      'Cookie 中没有 qm_keyst / qqmusic_key'
    )
  }

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

  const results = []

  for (
    const quality of [
      'M800',
      'M500',
      'C400'
    ]
  ) {
    try {
      const result =
        await tencentEVkey(
          songmid,
          detail.media_mid,
          quality,
          cookie
        )

      results.push({
        quality,

        ok:
          true,

        filename:
          result.filename,

        result:
          result.result,

        vkey:
          Boolean(
            result.vkey
          ),

        ekey:
          Boolean(
            result.ekey
          ),

        url:
          result.url ||
          '',

        raw:
          result.raw
      })
    } catch (error) {
      results.push({
        quality,

        ok:
          false,

        error:
          error?.message ||
          '未知错误'
      })
    }
  }

  return {
    ok:
      results.some(
        x =>
          x.ok
      ),

    songmid:

      songmid,

    media_mid:
      detail.media_mid,

    results
  }
}

// ============================================================
// QQ Music 播放地址
//
// 第一阶段：CgiGetVkey
// 第二阶段：CgiGetEVkey
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

  const cookie =
    await getTencentCookie(
      env
    )

  if (!cookie) {
    throw new Error(
      '未读取到 METING_COOKIE_TENCENT'
    )
  }

  const cookies =
    parseTencentCookie(
      cookie
    )

  const hasMusicKey =
    Boolean(
      cookies.qqmusic_key ||
      cookies.qm_keyst
    )

  if (!hasMusicKey) {
    throw new Error(
      'Cookie 中没有 qm_keyst / qqmusic_key'
    )
  }

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

  if (!detail.media_mid) {
    throw new Error(
      `QQ 未取得 media_mid，songmid=${songmid}`
    )
  }

  const qualities = [
    'M800',
    'M500',
    'C400'
  ]

  const vkeyErrors = []
  const evkeyErrors = []

  // ==========================================================
  // 第一阶段：CgiGetVkey
  // ==========================================================

  for (
    const quality of qualities
  ) {
    try {
      const result =
        await tencentVkey(
          songmid,
          detail.media_mid,
          quality,
          cookie
        )

      if (
        result?.url
      ) {
        return {
          ...result,

          method:
            'CgiGetVkey'
        }
      }
    } catch (error) {
      console.error(
        `QQ CgiGetVkey ${quality} 失败:`,
        error
      )

      vkeyErrors.push(
        `${quality}: ${
          error?.message ||
          '未知错误'
        }`
      )
    }
  }

  // ==========================================================
  // 第二阶段：CgiGetEVkey
  // ==========================================================

  for (
    const quality of qualities
  ) {
    try {
      const result =
        await tencentEVkey(
          songmid,
          detail.media_mid,
          quality,
          cookie
        )

      if (
        result?.url
      ) {
        return {
          ...result,

          method:
            'CgiGetEVkey'
        }
      }
    } catch (error) {
      console.error(
        `QQ CgiGetEVkey ${quality} 失败:`,
        error
      )

      evkeyErrors.push(
        `${quality}: ${
          error?.message ||
          '未知错误'
        }`
      )
    }
  }

  throw new Error(
    `QQ 音乐无法获取播放地址；` +
    `CgiGetVkey：${vkeyErrors.join(
      ' | '
    )}；` +
    `CgiGetEVkey：${evkeyErrors.join(
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
      'pic',
      'qqstatus',
      'evkey'
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
  // QQ 状态
  // ==========================================================

  if (
    server === 'tencent' &&
    type === 'qqstatus'
  ) {
    return c.json(
      await tencentStatus(
        c.env
      )
    )
  }

  // ==========================================================
  // QQ EVKEY 独立测试
  // ==========================================================

  if (
    server === 'tencent' &&
    type === 'evkey'
  ) {
    try {
      return c.json(
        await tencentEVkeyTest(
          id,
          c.env
        )
      )
    } catch (error) {
      console.error(
        'QQ EVKEY 独立测试失败:',
        error
      )

      throw new HTTPException(
        500,
        {
          message:
            `QQ EVKEY 测试失败: ${
              error?.message ||
              '未知错误'
            }`
        }
      )
    }
  }

  // ==========================================================
  // 鉴权
  // ==========================================================

  if (
    [
      'lrc',
      'url',
      'pic'
    ].includes(type)
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
        x => {
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

      c.header(
        'X-QQ-Method',
        result.method ||
          'unknown'
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
    // QQ
    // --------------------------------------------------------

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
      x => {
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