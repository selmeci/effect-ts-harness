import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

export default Alchemy.Stack(
  "sample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("Bucket")
    const db = yield* Cloudflare.D1.Database("PhotosDb", {
      migrations: "../../libs/sample/infra/migrations",
    })
    const photoCounterDo = Cloudflare.DurableObject("PhotoCounter", {
      className: "PhotoCounterDO",
    })

    return {
      bucketName: bucket.bucketName,
      databaseId: db.databaseId,
      photoCounterDo: photoCounterDo.name,
    }
  }),
)
