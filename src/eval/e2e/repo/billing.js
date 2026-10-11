import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2022-08-01" });

export async function upcomingLines(customerId) {
  const page = await stripe.invoices.listUpcomingLineItems({ customer: customerId });
  return page.data.map((line) => ({ description: line.description, amount: line.amount }));
}
