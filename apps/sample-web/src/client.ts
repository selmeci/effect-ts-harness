import { AtomHttpApi } from "effect/reactivity"
import { FetchHttpClient } from "effect/http"
import { type PhotoId, SampleApi } from "@harness/sample-contract"

export class SampleApiClient extends AtomHttpApi.Service<SampleApiClient>()("SampleApiClient", {
  api: SampleApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: "http://localhost:8787",
}) {}

export const listPhotosAtom = SampleApiClient.query("photos", "listPhotos", {})
export const getPhotoByIdAtom = (id: PhotoId) =>
  SampleApiClient.query("photos", "getPhoto", { params: { id } })
export const createPhotoMutation = SampleApiClient.mutation("photos", "createPhoto")
