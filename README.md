# @beezync/react-native

SDK de cliente de Beezync para React Native (TypeScript). Registra el dispositivo, abre el WebSocket en tiempo real y reporta recibos y clics de las notificaciones.

Sin dependencias de runtime: usa `fetch` y `WebSocket` de React Native. El token de push lo entrega `@react-native-firebase/messaging` (peer dependency opcional).

## Instalación

```sh
npm install @beezync/react-native
# para push (FCM en Android, FCM sobre APNs en iOS)
npm install @react-native-firebase/app @react-native-firebase/messaging
cd ios && pod install
```

Mientras el paquete no esté publicado: `npm pack` en esta carpeta e instala el `.tgz` resultante, o usa `"@beezync/react-native": "file:../ruta/al/sdk"`.

## Uso

```ts
import messaging from '@react-native-firebase/messaging';
import { Platform } from 'react-native';
import { BeezyncClient, getBeezyncId } from '@beezync/react-native';

const beezync = new BeezyncClient({
  appId: 'UUID_DE_LA_APP',
  publicKey: 'pk_...', // nunca la llave secreta
  baseUrl: 'https://api.beezync.com',
});

await messaging().requestPermission();
const token = await messaging().getToken();
await beezync.registerDevice({
  token,
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
  externalUserId: 'usuario-123',
  tags: { plan: 'pro' },
});

beezync.on('open', ({ socketId }) => console.log('conectado', socketId));
beezync.on('message', (m) => console.log(m)); // evento publicado o notificación por socket
beezync.on('close', ({ code, willReconnect }) => console.log('cerrado', code, willReconnect));
beezync.subscribe('noticias');
beezync.connect();
```

### Recibos y clics

Cada push lleva `bz_id` en `data`. `getBeezyncId` lo extrae del mensaje remoto de Firebase:

```ts
messaging().onMessage(async (remote) => {
  const id = getBeezyncId(remote);
  if (id) await beezync.trackReceived(id);
});

messaging().onNotificationOpenedApp((remote) => {
  const id = getBeezyncId(remote);
  if (id) beezync.trackClicked(id);
});

const initial = await messaging().getInitialNotification(); // app abierta desde cerrada
if (initial) beezync.trackClicked(getBeezyncId(initial) ?? '');
```

Para mensajes en segundo plano registra el handler al inicio de `index.js`, fuera de cualquier componente:

```ts
messaging().setBackgroundMessageHandler(async (remote) => {
  const id = getBeezyncId(remote);
  if (id) await beezync.trackReceived(id);
});
```

El servidor cuenta cada evento una vez por dispositivo, así que reportar dos veces es inofensivo.

### Canales privados

Los canales `private-*` necesitan `auth` (HMAC de `socket_id:channel`) o un `token` de suscripción. Ambos los genera tu servidor con la llave secreta; el SDK nunca la maneja.

```ts
beezync.subscribe('private-pedidos', {
  authorize: async (socketId, channel) => {
    const r = await fetch('https://tu-servidor/beezync/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ socket_id: socketId, channel }),
    });
    return r.json(); // { auth: '<hex>' }
  },
});
```

`authorize` se vuelve a llamar en cada reconexión porque el `socket_id` cambia. También se aceptan `subscribe(canal, 'hex')` y `subscribe(canal, { token })`.

### Hook de React

```tsx
import { useBeezync } from '@beezync/react-native';

function Feed() {
  const { connected, messages, clear } = useBeezync(beezync, { channels: ['noticias'] });
  // ...
}
```

Conecta al montar, desconecta al desmontar y mantiene los últimos `maxMessages` (100 por defecto).

## API

| Método | Descripción |
|---|---|
| `registerDevice({ token, platform, externalUserId?, tags? })` | `POST /v1/api/register-device` |
| `unregisterDevice(token?)` | `POST /v1/api/unregister-device` (por defecto el token registrado) |
| `setUser(externalUserId)` / `setTags(tags)` | `PATCH /v1/api/devices` |
| `connect()` / `disconnect()` | Abre o cierra el WebSocket |
| `subscribe(canal, auth?)` / `unsubscribe(canal)` | Canales; se resuscribe solo tras reconectar |
| `on(evento, fn)` / `onMessage(fn)` | Devuelven una función para quitar el listener |
| `trackReceived(id)` / `trackClicked(id)` / `trackDismissed(id)` | `POST /v1/api/notification-events` |
| `getBeezyncId(remoteMessage)` | Lee `bz_id` de un mensaje de Firebase |

Eventos: `message`, `open`, `close`, `subscribed`, `subscription_error`. Un mensaje es `{ kind: 'event', event, channel, data, id, ts }` o `{ kind: 'notification', id, title, body, channel?, data? }`.

Las operaciones HTTP nunca lanzan: devuelven `{ ok, status, data?, error?, code? }`.

## Reconexión

Al cerrarse el socket sin haber llamado `disconnect()` se reintenta con espera exponencial de 1 s a 30 s con variación aleatoria (±20 %). La espera se reinicia al recibir `connection_established`. El código de cierre `4200` reconecta de inmediato. Se envía un `ping` cada 25 s (`pingIntervalMs`).

## Configurar @react-native-firebase

1. Crea un proyecto en Firebase y registra las apps de Android e iOS con sus identificadores de paquete.
2. Descarga `google-services.json` y `GoogleService-Info.plist`.
3. En Beezync, configura la cuenta de servicio de Firebase de la app para que el motor envíe por FCM.

### Android

1. Copia `google-services.json` a `android/app/`.
2. En `android/build.gradle`, dentro de `dependencies` del bloque `buildscript`: `classpath("com.google.gms:google-services:4.4.2")`.
3. En `android/app/build.gradle`: `apply plugin: "com.google.gms.google-services"`.
4. Android 13 o superior: añade `<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />` al manifiesto y pide el permiso en tiempo de ejecución (`messaging().requestPermission()` lo hace).

### iOS (llave APNs en Firebase)

1. En Apple Developer, crea una llave APNs (Keys, habilita Apple Push Notifications service) y descarga el `.p8`; anota Key ID y Team ID.
2. En Firebase, Configuración del proyecto, Cloud Messaging, Configuración de la app de Apple: sube la llave `.p8` con Key ID y Team ID.
3. En Xcode, target de la app: Signing & Capabilities, añade **Push Notifications** y **Background Modes** (Remote notifications).
4. Añade `GoogleService-Info.plist` al target desde Xcode (no solo copiándolo a la carpeta).
5. En `AppDelegate`, llama a `[FIRApp configure];` al arrancar (ver la guía de React Native Firebase para tu versión de RN).
6. `cd ios && pod install`.
7. Las notificaciones push no funcionan en el simulador: usa un iPhone real.

## Desarrollo

```sh
npm install
npm run build          # compila a dist/ con tipos
npm test               # pruebas unitarias con node --test (fakes de fetch/WebSocket)
```

Prueba de integración contra un motor local (se omite si faltan las variables; la llave secreta solo se lee del entorno):

```sh
BEEZYNC_BASE_URL=http://127.0.0.1:8099 BEEZYNC_APP_ID=... BEEZYNC_PUBLIC_KEY=pk_... BEEZYNC_SECRET_KEY=sk_... \
  npm run test:integration
```

Registra un dispositivo con un usuario único, se conecta, publica por `/v1/api/publish`, envía un `send-push` con transporte `ws`, reporta recibido y clic, y comprueba los contadores en `GET /v1/api/notifications/{id}`.

El núcleo (`client`, `frames`, `backoff`) es TypeScript puro y corre en Node 22 o superior, donde `fetch` y `WebSocket` son globales. Para usar otras implementaciones pasa `fetch` y `createSocket` en la configuración.

## Licencia

© 2026 Beezync. Licencia MIT (ver `LICENSE`).
