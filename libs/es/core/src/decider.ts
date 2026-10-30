import { Effect } from "effect"

export interface Decider<Command, Event, State, Err> {
  readonly initialState: State
  readonly evolve: (state: State, event: Event) => State
  readonly decide: (
    command: Command,
    state: State
  ) => Effect.Effect<ReadonlyArray<Event>, Err, never>
}

export const Decider = {
  make: <Command, Event, State, Err>(options: {
    readonly name?: string | undefined
    readonly initialState: State
    readonly evolve: (state: State, event: Event) => State
    readonly decide: (
      command: Command,
      state: State
    ) => Effect.Effect<ReadonlyArray<Event>, Err, never>
  }): Decider<Command, Event, State, Err> => ({
    initialState: options.initialState,
    evolve: options.evolve,
    decide: (command, state) =>
      Effect.withSpan(options.decide(command, state), options.name ?? "Decider.decide")
  })
}
