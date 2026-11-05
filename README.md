<p align="center">
  <strong>English</strong> &nbsp;·&nbsp; <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="doc/assets/readme/hero-en.svg" alt="Socrates — Think together. Build together. A desktop workspace for multi-AI discussion, agent collaboration, and custom characters." width="100%">
</p>

<p align="center">
  <strong>A great idea deserves more than one perspective.</strong><br>
  Bring different AI models into one room. Give them a voice, a role, and a shared purpose.<br>
  Discuss in <strong>Chat</strong>. Put the plan to work in <strong>Work</strong>.
</p>

<p align="center">
  <a href="#get-started">Get started</a> &nbsp; / &nbsp;
  <a href="#01--chat-let-the-ideas-meet">Explore Chat</a> &nbsp; / &nbsp;
  <a href="#02--work-turn-the-conversation-into-progress">Explore Work</a> &nbsp; / &nbsp;
  <a href="#03--your-models-your-characters">Meet your cast</a>
</p>

---

## 01 / Chat. Let the ideas meet.

**One question. Different models. A conversation that builds on itself.**

Invite an architect, a researcher, and a skeptic into the same room. Let them propose ideas, question assumptions, and work toward a useful conclusion—with every voice visible in a shared conversation.

![Chat in Socrates: two AI characters discuss and challenge a reading-app design.](doc/assets/readme/chat.png)

- **Mix models and perspectives.** Use your configured OpenAI-compatible and Anthropic providers in the same room.
- **Choose who responds.** Talk to a default member, select a member with `@`, or start a bounded team discussion.
- **Keep it conversational.** Chat has no workspace or local execution tools. It is a place to think, compare, and decide.

<sub>Actual application UI with demonstration conversations and illustrative model replies.</sub>

## 02 / Work. Turn the conversation into progress.

**A team with responsibilities, a workspace, and a plan you can inspect.**

Attach a local project and choose how to work: ask one agent to handle a task, discuss an approach, or explicitly start team collaboration. The Manager breaks the task into work packages; members carry out their assignments after the plan is approved.

![Socrates Work: inspect a Manager plan, assigned members, dependencies, and acceptance criteria before approving execution.](doc/assets/readme/work.png)

<img src="doc/assets/readme/workflow-en.svg" alt="Optional discussion → Manager plan → approval → member execution → optional review." width="100%">

- **Know who owns what.** Work packages carry an owner, dependencies, expected results, and acceptance criteria.
- **Stay in the loop.** Inspect the plan, approve execution, follow member progress, and pause or resume a task.
- **Build in your project.** The native runtime can read and edit files and run commands with permission controls. Optional agent review can request bounded rework.

Members share a workspace, with execution queued to avoid conflicting writes. Collaboration does not imply simultaneous edits to the same files.

<sub>Actual application UI in an isolated demonstration workspace. The plan shown is illustrative.</sub>

## 03 / Your models. Your characters.

**A model is the engine. You decide who joins the conversation.**

<img src="doc/assets/readme/personas-en.svg" alt="Custom AI characters with recognizable pixel avatars: Lunar Sage, Azure Fox, and Moss Scout. Thousands of English and Chinese name combinations." width="100%">

Create a practical teammate or a character with a particular point of view. Choose a model, write a role and system prompt, and give it an identity you can recognize at a glance.

- **Thousands of names.** 2,048 base combinations each in English, Simplified Chinese, and Traditional Chinese, with duplicate-name avoidance.
- **Distinctive pixel avatars.** Generate new patterns locally. Both silhouette and colour vary, so identity does not depend on colour alone.
- **Make it yours.** Keep a classic character or upload a PNG, JPEG, WebP, or GIF up to 2 MB. Shuffle the name and avatar independently.
- **Create where you work.** Use the character library, create a role while making a room, or add one from room members.

<details>
<summary><strong>See the character editor</strong></summary>

![The Socrates character editor with name-language selection, generated avatars, image upload, model, role, and prompt.](doc/assets/readme/character-editor.png)

</details>

## Two modes. A clear choice.

| | Chat | Work |
| :-- | :-- | :-- |
| Best for | Exploring ideas, debate, reviews, role-play | Implementing tasks in a local project |
| Members | One or more AI characters | One or more AI agents |
| How they respond | Selected member or team discussion | Direct execution, discussion, or a team plan |
| Local files and commands | No | Yes, through the native runtime and permissions |
| Your control | Participants and discussion settings | Workspace, plan approval, execution, and review |

Adding more members never silently changes the collaboration strategy. You choose how the room works.

## Get started

Socrates is under active development. The development workflow is currently centred on **macOS**; see the [architecture](doc/architecture.md) for implementation details.

Install [Bun](https://bun.sh) and [Rust](https://rustup.rs), with the macOS development tools available, then:

```bash
git clone https://github.com/Haosen-Zhang/Socrates.git
cd Socrates
bun install
bun run dev
```

The first desktop launch compiles the Rust application and can take a few minutes.

1. **Connect your models.** Open **Settings → Providers** and add a provider and your API key.
2. **Create your cast.** Open **Pixel agents**, choose a model, and set a name, avatar, role, and prompt.
3. **Open a room.** Choose **Chat** for a conversation, or **Work** with a local workspace for execution.

API keys are stored in the system Keychain on macOS. Conversations and task history are stored locally; the prompts and context you send are processed by your configured model providers. Model usage uses your provider credentials and billing.

## Built for a workspace you control

**Tauri + React** on the desktop. **Bun + Hono** underneath. **SQLite** for local state. A shared **TypeScript** domain layer keeps room and execution rules consistent.

| Package | Responsibility |
| :-- | :-- |
| [`apps/desktop`](apps/desktop) | Desktop UI, room timelines, character editor, and workspace views |
| [`apps/sidecar`](apps/sidecar) | Providers, orchestration, persistence, approvals, and native agent runtime |
| [`packages/core`](packages/core) | Shared types, contracts, validation, and state machines; no UI or I/O |

```bash
bun test
bun run typecheck
bun run --cwd apps/desktop build
```

Explore the [current architecture](doc/architecture.md), [Chat / Work implementation](doc/chat-work-collaboration-acceptance.md), [reliability verification](doc/chat-work-reliability-repair-acceptance.md), and [runtime roadmap](doc/native-runtime-and-langgraph-roadmap.md). The production execution engine is Socrates Native Runtime; the roadmap distinguishes future work from shipped behaviour.

Found a problem or have an idea? [Open an issue](https://github.com/Haosen-Zhang/Socrates/issues). Contributions follow the [repository workflow](AGENTS.md).

---

<p align="center">
  <strong>Different minds. Shared momentum.</strong><br>
  <sub>Built for the conversations that lead somewhere.</sub><br><br>
  <a href="README.zh-CN.md">阅读中文版 →</a>
</p>
