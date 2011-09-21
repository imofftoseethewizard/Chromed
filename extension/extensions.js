//==============================================================================================
//
// This file is part of Chromed.
//
// Chromed is free software: you can redistribute it and/or modify it under the terms of the GNU
// General Public License as published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// Chromed is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
// even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// General Public License for more details.
//
// You should have received a copy of the GNU General Public License along with Chromed.  If not,
// see <http://www.gnu.org/licenses/>.
//
// Copyright (c) 2011 Pat M. Lasswell
//
//==============================================================================================


chrome.windows.getTabByUrl = function getTabByUrl(url, C) {
  chrome.windows.getAll({ populate: true }, function(windows) {
    var tabs = [];
    for (var i = 0; i < windows.length; i++)
      tabs = tabs.concat(windows[i].tabs);

    for (var i = 0; i < tabs.length; i++)
      if (tabs[i].url == url)
	return C(tabs[i]);

    C(null);
  });
}

chrome.windows.findOrCreateTab = function findOrCreateTab(url, C) {
  chrome.windows.getTabByUrl(url, function(tab) {
    if (tab == null)
      chrome.tabs.create({ url: url }, C);
    else
      C(tab);
  });
}

document.clickElement = function clickElement(elem) {
  if (document.createEvent) {
    var event = document.createEvent("MouseEvents");
    event.initMouseEvent("click", true, true, window,
			 0, 0, 0, 0, 0,
			 false, false, false, false,
			 0, null);
    elem.dispatchEvent(event);
  }
  else if (elem.fireEvent) {
    elem.fireEvent("onclick");
  }
}

document.selectChoiceByValue = function selectChoiceByValue(select, value) {
  var options = select.children;
  for (var i = 0; i < options.length; i++)
    if (options[i].value == value) {
      select.selectedIndex = i;
      break;
    }
}



// Local Variables:
// mode: javascript
// c-basic-offset: 2
// indent-tabs-mode: nil
// fill-column: 98
// End:
