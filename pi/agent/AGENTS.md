   # Global Agent Instructions

   This environment uses a custom TDD code generation tool ("ticket-pipeline")
   that drives implementation from Linear tickets via a criteria-stack state
   machine. The entry point is `scaffold` (try `scaffold --help`). Detailed
   knowledge of the TDD loop, commands, phase transitions, and pipeline state
   files is available via the `scaffold` skill — load it with `/skill:scaffold`
   when working with the pipeline.

   When the user asks to plan work and create tickets in Linear, load the
   planner skill with `/skill:planner`.

   When the user provides unstructured context (conversation transcripts,
   design notes, ad-hoc observations) and wants it turned into scaffold-ready
   work items without going through Linear first, load the to_tickets skill
   with `/skill:to_tickets`.
