import { Dispatch, SetStateAction, createContext } from "react";

export const DatePickerContext = createContext<{
  isOpen: boolean;
  setIsOpen: Dispatch<SetStateAction<boolean>>;
}>({
  isOpen: false,
  setIsOpen: () => {},
});
