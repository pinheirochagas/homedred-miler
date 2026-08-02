const DB_NAME = 'homedred-media'
const DB_VERSION = 1
const STORE = 'captures'

let databasePromise

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('Storage transaction aborted'))
  })
}

function openDatabase() {
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (db.objectStoreNames.contains(STORE)) return
      const store = db.createObjectStore(STORE, { keyPath: 'id' })
      store.createIndex('capturedAt', 'capturedAt')
      store.createIndex('status', 'status')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return databasePromise
}

export async function putCapture(capture) {
  const db = await openDatabase()
  const transaction = db.transaction(STORE, 'readwrite')
  transaction.objectStore(STORE).put(capture)
  await transactionDone(transaction)
  return capture
}

export async function getCapture(id) {
  const db = await openDatabase()
  const transaction = db.transaction(STORE, 'readonly')
  return requestResult(transaction.objectStore(STORE).get(id))
}

export async function getCaptures() {
  const db = await openDatabase()
  const transaction = db.transaction(STORE, 'readonly')
  const captures = await requestResult(transaction.objectStore(STORE).getAll())
  return captures.sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt))
}

export async function updateCapture(id, patch) {
  const current = await getCapture(id)
  if (!current) return null
  const updated = { ...current, ...patch }
  await putCapture(updated)
  return updated
}

export async function deleteCapture(id) {
  const db = await openDatabase()
  const transaction = db.transaction(STORE, 'readwrite')
  transaction.objectStore(STORE).delete(id)
  await transactionDone(transaction)
}

export async function clearUploadedCaptures() {
  const db = await openDatabase()
  const transaction = db.transaction(STORE, 'readwrite')
  const store = transaction.objectStore(STORE)
  const captures = await requestResult(store.getAll())
  for (const capture of captures) {
    if (capture.status === 'uploaded') store.delete(capture.id)
  }
  await transactionDone(transaction)
}
