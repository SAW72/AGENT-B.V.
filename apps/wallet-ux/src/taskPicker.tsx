import { TASKS, navigate, taskHref, useWalletRoute } from "./routes"

export function TaskPicker({ voteReason }: { voteReason: string | null }) {
  const route = useWalletRoute()
  return (
    <section className="card" aria-label="What do you want to do?" data-testid="task-picker">
      <h2>What do you want to do?</h2>
      <ul className="task-list">
        {TASKS.map((task) => {
          const blocked = task.flow === "vote" && voteReason != null
          const href = taskHref(task.flow, { escrow: route.escrow.value, dispute: route.dispute.value })
          return (
            <li key={task.flow} className="task-card" data-testid={`task-${task.flow}`}>
              <h3>{task.title}</h3>
              <p>{task.text}</p>
              {blocked ? (
                <>
                  <button type="button" className="task-link" disabled>
                    {task.title}
                  </button>
                  <p className="action-reason" data-testid="vote-task-reason">
                    {voteReason}
                  </p>
                </>
              ) : (
                <a
                  className="task-link"
                  href={href}
                  onClick={(event) => {
                    event.preventDefault()
                    navigate(href)
                  }}
                >
                  {task.title}
                </a>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
