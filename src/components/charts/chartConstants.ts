import { Role } from "../../logic/gameModel";

export const ROLE_COLORS: Record<Role, string> = {
  retailer: "#d73027",
  wholesaler: "#4575b4",
  distributor: "#1a9850",
  factory: "#984ea3",
};

export const ROLE_LABELS: Record<Role, string> = {
  retailer: "Retailer",
  wholesaler: "Wholesaler",
  distributor: "Distributor",
  factory: "Factory",
};
