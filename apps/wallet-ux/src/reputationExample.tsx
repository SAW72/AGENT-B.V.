import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { EXAMPLE_DATA_LABEL, exampleSnapshot } from "./reputation/exampleData"
import { ReputationView } from "./reputation/ReputationView"
import "./styles.css"

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root")

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <div className="wrap">
      <div className="callout" data-testid="example-data-page" role="status">
        <strong>EXAMPLE DATA</strong>
        <p>Dev harness. These rows are copied fixtures, not a live refund service response.</p>
      </div>
      <ReputationView
        connected
        chainId={BASE_SEPOLIA_CHAIN_ID}
        address={exampleSnapshot.balance.address}
        relayerUrl={null}
        introduced={false}
        example={exampleSnapshot}
        exampleLabel={EXAMPLE_DATA_LABEL}
      />
    </div>
  </QueryClientProvider>,
)
