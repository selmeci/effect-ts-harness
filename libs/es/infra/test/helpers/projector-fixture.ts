export const at = <T>(arr: ReadonlyArray<T>, idx: number): T => {
  const el = arr[idx]
  if (el === undefined) {
    throw new Error(`Expected element at index ${idx}`)
  }
  return el
}
