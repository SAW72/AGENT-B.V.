import { TASKS, navigate, taskHref, useWalletRoute } from "./routes"

export function TaskPicker({ voteReason, secondary = false }: { voteReason: string | null; secondary?: boolean }) {
  const route = useWalletRoute()
  const linkClass = secondary ? "task-link secondary" : "task-link"
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
                  <button type="button" className={linkClass} disabled>
                    {task.title}
                  </button>
                  <p className="action-reason" data-testid="vote-task-reason">
                    {voteReason}
                  </p>
                </>
              ) : (
                <a
                  className={linkClass}
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
