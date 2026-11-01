// SPDX-License-Identifier: AGPL-3.0-only
import { createContext } from "react";
import type { UsageViewId } from "@hapi/protocol/schemas";

/**
 * The usage view a provider section shows (#4467, epic #4460 G). The Accounts
 * page's `ProviderSection` provides it to its body; a card reads it in its
 * healthy-meters arm only. With no provider (the switch modal, any card outside
 * a section) it is `null`, which renders Bars (R8).
 */
export const UsageViewContext = createContext<UsageViewId | null>(null);
