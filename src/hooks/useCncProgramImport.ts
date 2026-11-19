import { createContext, useContext, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from "react";

export type CncProgramReceiver = { name: string; accept: (program: string) => void };
export const CncProgramImportContext = createContext<Dispatch<SetStateAction<CncProgramReceiver | null>> | null>(null);

export function useCncProgramImport(name: string | undefined, accept: CncProgramReceiver["accept"]) {
  const register = useContext(CncProgramImportContext), current = useRef(accept);
  useLayoutEffect(() => { current.current = accept; });
  useLayoutEffect(() => {
    if (!register || !name) return;
    const receiver = { name, accept: (program: string) => current.current(program) };
    register(receiver);
    return () => register(active => active === receiver ? null : active);
  }, [name, register]);
}
